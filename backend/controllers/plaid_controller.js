import Router from "express";
import Sentry from "@sentry/node";
import { config } from "../config/config.js";
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import { UsersModel } from "../models/usersModel.js";
import { AccountsModel } from "../models/accountsModel.js";
import { TransactionsModel } from "../models/transactionsModel.js";
import Queue from "bee-queue";
import redis from "redis";
import axios from "axios";
import { Op } from "sequelize";
import cron from "node-cron";
import { validateAccessToken, isAuthorizedUserId } from "../middleware/auth.js";

const redisClient = redis.createClient({
  host: "localhost",
  port: 6379,
});
const transactionQueue = new Queue("transactions", {
  redis: redisClient,
});
const syncQueue = new Queue("sync", {
  redis: redisClient,
});

const configuration = new Configuration({
  basePath: PlaidEnvironments[config.PLAID_ENV],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": config.PLAID_CLIENT_ID,
      "PLAID-SECRET": config.PLAID_SECRET,
      "Plaid-Version": "2020-09-14",
    },
  },
});

const client = new PlaidApi(configuration);

// Base route: /api/plaid
export const plaidController = Router();

// Obtain a link_token: GET /api/plaid/link_token?userId=${}
plaidController.get(
  "/link_token",
  validateAccessToken,
  isAuthorizedUserId,
  async (req, res) => {
    try {
      const userId = req.query.userId;
      if (!userId) {
        return res
          .status(400)
          .send("Missing required fields. Must contain [userId]");
      }
      const createTokenResponse = await client.linkTokenCreate({
        user: {
          client_user_id: userId,
        },
        client_name: "SpendWise",
        products: ["transactions"],
        country_codes: ["US"],
        language: "en",
      });
      return res.status(200).send({
        link_token: createTokenResponse.data.link_token,
      });
    } catch (err) {
      // Sentry.captureException(err);
      return res.status(500).send("Internal Server error " + err);
    }
  }
);

// Exchange the public_token for an access_token and store it in the database: POST /api/plaid/token_exchange
plaidController.post(
  "/token_exchange",
  validateAccessToken,
  isAuthorizedUserId,
  async (req, res) => {
    try {
      const public_token = req.body.public_token;
      const userId = req.body.userId;

      if (!public_token || !userId) {
        return res
          .status(400)
          .send("Missing required fields. Must contain [publicToken, userId]");
      }
      const tokenResponse = await client.itemPublicTokenExchange({
        public_token: public_token,
      });

      let ACCESS_TOKEN = tokenResponse.data.access_token;
      if (!ACCESS_TOKEN) {
        return res.status(400).send("Error getting access token");
      }

      // given the userId, update the user's access_token in the database
      const user = await UsersModel.findOne({ where: { id: userId } });
      if (!user) {
        return res.status(400).send("Error getting user");
      }
      const data = {
        access_token: ACCESS_TOKEN,
        email: user.email,
        cursor: null,
      };
      await user.update(data);
      await user.save();
      return res.status(200).send("Success");
    } catch (e) {
      return res.status(500).send("Internal Server error " + err);
    }
  }
);

//Sync transactions given an userId that is linked to plaid: GET /api/plaid/transactions/sync?userId=${}
plaidController.get(
  "/transactions/sync",
  validateAccessToken,
  isAuthorizedUserId,
  async (req, res) => {
    try {
      const userId = req.query.userId;
      if (!userId) {
        return res
          .status(400)
          .send("Missing required fields. Must contain [userId]");
      }

      const user = await UsersModel.findOne({ where: { id: userId } });
      if (!user) {
        return res.status(400).send("Error getting user");
      }
      let ACCESS_TOKEN = user.access_token;
      if (!ACCESS_TOKEN) {
        return res
          .status(400)
          .send("User not linked to Plaid for user " + userId);
      }

      let cursor = user.cursor ? user.cursor : null;
      let added = [];
      let modified = [];
      let removed = [];
      let hasMore = true;

      // Invalidate the access token to get a new one for periodic sync
      const invalidateAccessTokenresponse =
        await client.itemAccessTokenInvalidate({
          access_token: ACCESS_TOKEN,
        });
      if (invalidateAccessTokenresponse.data.error) {
        // Sentry.captureException(invalidateAccessTokenresponse.data.error);
        return res.status(400).send(data.error);
      }
      ACCESS_TOKEN = invalidateAccessTokenresponse.data.new_access_token;
      user.access_token = ACCESS_TOKEN;

      // Sync transactions
      while (hasMore) {
        const response = await client.transactionsSync({
          access_token: ACCESS_TOKEN,
          cursor: cursor,
        });
        const data = response.data;
        // Add this page of results
        added = added.concat(data.added);
        modified = modified.concat(data.modified);
        removed = removed.concat(data.removed);
        hasMore = data.has_more;
        // Update cursor to the next cursor
        cursor = data.next_cursor;
      }
      user.cursor = cursor;
      await user.save();

      // Create a job to process the transactions
      transactionQueue
        .createJob({
          ACCESS_TOKEN,
          userId,
          added,
          modified,
          removed,
        })
        .on("succeeded", function () {
          console.log(`Job succeeded`);
        })
        .on("failed", function (errorMessage) {
          console.log(`Job failed with error message: ${errorMessage}`);
        })
        .on("retrying", function (err) {
          console.log(
            `Job failed with error message: ${err.message}.  It is being retried!`
          );
        })
        .save();

      return res.status(200).send("Job started successfully");
    } catch (err) {
      return res.status(500).send("Internal Server error " + err);
    }
  }
);

// check if user has linked Plaid: GET /api/plaid/has_linked_plaid?userId=${}
plaidController.get(
  "/has_linked_plaid",
  validateAccessToken,
  isAuthorizedUserId,
  async (req, res) => {
    try {
      const userId = req.query.userId;
      if (!userId) {
        return res
          .status(400)
          .send("Missing required fields. Must contain [userId]");
      }
      const user = await UsersModel.findOne({ where: { id: userId } });
      if (!user) {
        return res.status(400).send("Error getting user");
      }
      if (user.access_token) {
        return res.status(200).send("Success");
      } else {
        return res.status(400).send("No access token");
      }
    } catch (err) {
      // Sentry.captureException(err);
      return res.status(500).send("Internal Server error " + err);
    }
  }
);
async function createPlaidTransactions(added) {
  for (let transaction of added) {
    const plaidAccountId = transaction.account_id;
    const account = await AccountsModel.findOne({
      where: { plaidAccountId: plaidAccountId },
    });
    const transactionExists = await TransactionsModel.findOne({
      where: { plaidTransactionId: transaction.transaction_id },
    });
    if (transactionExists) {
      continue;
    } else {
      await TransactionsModel.create({
        transactionDate: transaction.date,
        descriptions: transaction.name,
        amount: transaction.amount,
        AccountId: account.id,
        category: transaction.category[0],
        plaidTransactionId: transaction.transaction_id,
      });
    }
  }
}
async function updatePlaidTransactions(modified) {
  for (let transaction of modified) {
    const plaidAccountId = transaction.account_id;
    const account = await AccountsModel.findOne({
      where: { plaidAccountId: plaidAccountId },
    });

    // update the existing transaction for the existing account
    const existingTransaction = await TransactionsModel.findOne({
      where: { plaidTransactionId: transaction.transaction_id },
    });
    if (!existingTransaction) {
      // create a new transaction for the existing account
      const newTransaction = await TransactionsModel.create({
        transactionDate: transaction.date,
        descriptions: transaction.name,
        amount: transaction.amount,
        AccountId: account.id,
        category: transaction.category[0],
        plaidTransactionId: transaction.transaction_id,
      });
    } else {
      // update the existing transaction for the existing account
      existingTransaction.transactionDate = transaction.date;
      existingTransaction.descriptions = transaction.name;
      existingTransaction.amount = transaction.amount;
      existingTransaction.category = transaction.category[0];
      await existingTransaction.save();
    }
  }
}
async function deletePlaidTransactions(removed) {
  for (let transaction of removed) {
    const existingTransaction = await TransactionsModel.findOne({
      where: { plaidTransactionId: transaction.transaction_id },
    });
    if (existingTransaction) {
      await existingTransaction.destroy();
    }
  }
}
async function updatePlaidAccounts(ACCESS_TOKEN, userId) {
  const accountsResponse = await client.accountsGet({
    access_token: ACCESS_TOKEN,
  });

  for (let account of accountsResponse.data.accounts) {
    const plaidAccountId = account.account_id;
    const accountFounded = await AccountsModel.findOne({
      where: { plaidAccountId: plaidAccountId },
    });
    if (accountFounded) {
      await accountFounded.update({
        accountName: account.name,
        plaidAccountId: account.account_id,
      });
      await accountFounded.save();
    } else {
      for (let account of accountsResponse.data.accounts) {
        // create new accounts for this user
        const createdAccount = await AccountsModel.create({
          accountName: account.name,
          plaidAccountId: account.account_id,
          UserId: userId,
        });
        await createdAccount.save();
      }
    }
  }
}
async function syncTransactions(userId) {
  try {
    const response = await axios.get(
      "http://localhost:3001/api/plaid/transactions/sync?userId=" + userId
    );
    console.log(response.data);
  } catch (err) {
    console.log(err);
    // Sentry.captureException(err + " in cron job syncTransactions"");
  }
}

cron.schedule("0 0 * * *", async () => {
  console.log("Running cron job at midnight every day!");

  // get all users that have linked Plaid
  try {
    const users = await UsersModel.findAll({
      where: { access_token: { [Op.ne]: null } },
    });

    for (const user of users) {
      // create a job to sync transactions for each user
      syncQueue.createJob({ userId: user.id }).save();
    }
  } catch (err) {
    console.log(err);
    // Sentry.captureException(err + " in cron job"");
  }
});
syncQueue.process(async (job) => {
  const { userId } = job.data;
  await syncTransactions(userId);
});

transactionQueue.process(async (job) => {
  const { ACCESS_TOKEN, userId, added, modified, removed } = job.data;
  // add new accounts to our database if not already exists
  await updatePlaidAccounts(ACCESS_TOKEN, userId);
  // createPlaidTransactions based on added
  await createPlaidTransactions(added);
  // updatePlaidTransactions based on modified
  await updatePlaidTransactions(modified);
  // deletePlaidTransactions based on removed
  await deletePlaidTransactions(removed);
});
