const dotenv = require("dotenv");
dotenv.config();

const { App } = require("@slack/bolt");
var crypto = require("crypto");
var { Pool } = require("pg");

var { banList } = require("./banList.json");

const useSocketMode =
  process.env.SOCKET_MODE === "true" ||
  (!process.env.SOCKET_MODE && !!process.env.SLACK_APP_TOKEN);

// env validation
const requiredEnvVars = [
  "SLACK_SIGNING_SECRET",
  "SLACK_BOT_TOKEN",
  "POSTGRES_URL",
  "REVIEW_CHANNEL_ID",
  ...(useSocketMode ? ["SLACK_APP_TOKEN"] : []),
];
let missingVars = [];
requiredEnvVars.forEach((varName) => {
  if (!process.env[varName]) {
    missingVars.push(varName);
  }
});
if (missingVars.length > 0) {
  console.error(
    `⤫ Missing required environment variables: ${missingVars.join(", ")}`
  );
  process.exit(1);
}

// psql setup
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

// create table nd setup if not exist already
// Initialize database table
async function initDatabase() {
  try {
    async function createIndexes() {
      await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_user_hash ON messages(user_hash)
    `);

      await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_status ON messages(status)
    `);
    }
    if (
      await pool
        .query(`SELECT to_regclass('public.messages') AS table_exists;`)
        .then((res) => res.rows[0].table_exists)
    ) {
      // db already exists, just create indexes
      await createIndexes();
      return;
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        user_hash VARCHAR(32) NOT NULL,
        message TEXT NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        reviewed_at TIMESTAMP,
        review_message_ts VARCHAR(50),
        thread_ts VARCHAR(50),
        channel_id VARCHAR(50)
      )
    `);

    await createIndexes();

    console.log("✓ Initial PSQL Database initialized successfully");
  } catch (error) {
    console.error("⤫ Initial PSQL Database initialization error:", error);
    process.exit(1);
  }
}
initDatabase();

// slack app setup
const appConfig = {
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
};
if (useSocketMode) {
  appConfig.socketMode = true;
  appConfig.appToken = process.env.SLACK_APP_TOKEN;
}
const app = new App(appConfig);

async function sendToReviewChannel(message, hashedUser, messageId) {
  const result = await app.client.chat.postMessage({
    token: process.env.SLACK_BOT_TOKEN,
    channel: process.env.REVIEW_CHANNEL_ID,
    text: `Pending impression from (${hashedUser.substring(
      0,
      8
    )}):\n>${message}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Pending Impression*\nFrom: \`${hashedUser.substring(
            0,
            8
          )}...\`\n\n>${message}`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "✅ Accept",
            },
            style: "primary",
            action_id: "accept_impression",
            value: messageId.toString(),
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "❌ Deny",
            },
            style: "danger",
            action_id: "deny_impression",
            value: messageId.toString(),
          },
        ],
      },
    ],
  });

  await pool.query("UPDATE messages SET review_message_ts = $1 WHERE id = $2", [
    result.ts,
    messageId,
  ]);

  return result;
}

// handle accepted impressions
app.action("accept_impression", async ({ ack, body, client }) => {
  await ack();

  const messageId = parseInt(body.actions[0].value);

  try {
    const result = await pool.query("SELECT * FROM messages WHERE id = $1", [
      messageId,
    ]);

    if (result.rows.length === 0) {
      throw new Error("Message not found");
    }

    const messageData = result.rows[0];

    // Update status to accepted
    await pool.query(
      "UPDATE messages SET status = $1, reviewed_at = NOW() WHERE id = $2",
      ["accepted", messageId]
    );

    // Post to the honest impressions channel
    const channelId =
      process.env.HONEST_IMPRESSIONS_CHANNEL_ID || "C029QJD8M0D";
    await client.chat.postMessage({
      token: process.env.SLACK_BOT_TOKEN,
      channel: channelId,
      thread_ts: messageData.thread_ts,
      text: messageData.message,
    });

    // Update the review message
    await client.chat.update({
      token: process.env.SLACK_BOT_TOKEN,
      channel: body.channel.id,
      ts: body.message.ts,
      text: `✅ Accepted by <@${body.user.id}>`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${messageData.message}\n\n✅ *Accepted* by <@${body.user.id}>`,
          },
        },
      ],
    });
  } catch (error) {
    console.error("Error accepting impression:", error);
    await client.chat.postEphemeral({
      token: process.env.SLACK_BOT_TOKEN,
      channel: body.channel.id,
      user: body.user.id,
      text: `Error accepting impression: ${error.message}`,
    });
  }
});

// handle denied impressions
app.action("deny_impression", async ({ ack, body, client }) => {
  await ack();

  const messageId = parseInt(body.actions[0].value);

  try {
    // Get the message from database
    const result = await pool.query("SELECT * FROM messages WHERE id = $1", [
      messageId,
    ]);

    if (result.rows.length === 0) {
      throw new Error("Message not found");
    }

    const messageData = result.rows[0];

    // Update status to denied
    await pool.query(
      "UPDATE messages SET status = $1, reviewed_at = NOW() WHERE id = $2",
      ["denied", messageId]
    );

    // Update the review message
    await client.chat.update({
      token: process.env.SLACK_BOT_TOKEN,
      channel: body.channel.id,
      ts: body.message.ts,
      text: `❌ Denied by <@${body.user.id}>`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `~${messageData.message}~\n\n❌ *Denied* by <@${body.user.id}>`,
          },
        },
      ],
    });
  } catch (error) {
    console.error("Error denying impression:", error);
    await client.chat.postEphemeral({
      token: process.env.SLACK_BOT_TOKEN,
      channel: body.channel.id,
      user: body.user.id,
      text: `Error denying impression: ${error.message}`,
    });
  }
});

(async () => {
  // Start the app
  await app.start(process.env.PORT || 3000);

  console.log("⚡️ Bolt app is running!");
})();

// delete shortcut for admins
app.shortcut("delete_me", async ({ ack, body, say }) => {
  ack();
  if (
    [
      "UJYDFQ2QL",
      "UHFEGV147",
      "U01D6FYHLUW",
      "UM4BAKT6U",
      "U0128N09Q8Y",
    ].includes(body.user.id)
  ) {
    await app.client.chat.delete({
      token: process.env.SLACK_BOT_TOKEN,
      ts: body.message.ts,
      channel: body.channel.id,
    });
    await app.client.chat.postEphemeral({
      token: process.env.SLACK_BOT_TOKEN,
      channel: body.channel.id,
      user: body.user.id,
      text: `doned`,
    });
    return;
  }
  await app.client.chat.postEphemeral({
    token: process.env.SLACK_BOT_TOKEN,
    channel: body.channel.id,
    user: body.user.id,
    text: `grrr stop bullying`,
  });
});

// replies to impression anonymously
app.shortcut("reply_impression", async ({ ack, body, say }) => {
  await ack();

  // check if not in banlist
  if (banList.includes(body.user.id)) {
    await app.client.chat.postEphemeral({
      token: process.env.SLACK_BOT_TOKEN,
      channel: body.channel.id,
      user: body.user.id,
      text: `You are not allowed to submit honest impressions.`,
    });
    return;
  }

  // if reply not in honest impressions channel, disallow
  if (
    !["C02A6BRM2JD", "G01PPVD14Q0", "C08TS367V2T"].includes(body.channel.id) &&
    !(process.env.HONEST_IMPRESSIONS_CHANNEL_ID === body.channel.id) &&
    !["UJYDFQ2QL"].includes(body.user.id)
  ) {
    await app.client.chat.postEphemeral({
      token: process.env.SLACK_BOT_TOKEN,
      channel: body.channel.id,
      user: body.user.id,
      text: `Post the honest impression in <#C029QJD8M0D>`,
    });
    return;
  }

  await app.client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal",
      callback_id: "impression_id",
      title: {
        type: "plain_text",
        text: "Honest Impressions",
      },
      blocks: [
        {
          type: "input",
          block_id: "input_c",
          label: {
            type: "plain_text",
            text: "Honestly I think....",
          },
          element: {
            type: "plain_text_input",
            action_id: "dreamy_input",
            multiline: true,
          },
        },
      ],
      submit: {
        type: "plain_text",
        text: "Submit (Anonymous)",
      },
      private_metadata: `${body.message_ts}|${body.channel.id}`,
    },
  });
});

app.view("impression_id", async ({ ack, body, view, client }) => {
  // avoid timeout
  await ack();

  const userHash = crypto.createHash("md5").update(body.user.id).digest("hex");
  const message = view.state.values.input_c.dreamy_input.value;
  const [threadTs, channelId] = view.private_metadata.split("|");

  try {
    // Store in PostgreSQL with thread_ts and channel_id
    const result = await pool.query(
      "INSERT INTO messages (user_hash, message, status, thread_ts, channel_id) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [userHash, message, "pending", threadTs, channelId]
    );

    const messageId = result.rows[0].id;

    // Send to review channel
    await sendToReviewChannel(message, userHash, messageId);

    // Send confirmation to user
    await client.chat.postEphemeral({
      token: process.env.SLACK_BOT_TOKEN,
      channel: channelId,
      user: body.user.id,
      text: "✅ Your anonymous impression has been submitted for review, and will appear in the thread once accepted.",
    });
  } catch (error) {
    console.error("Error submitting impression:", error);
    try {
      await client.chat.postEphemeral({
        token: process.env.SLACK_BOT_TOKEN,
        channel: channelId,
        user: body.user.id,
        text: "Failed to submit impression. Please try again.",
      });
    } catch (_) {}
  }
});

// kill pool on exit
process.on("SIGTERM", () => {
  pool.end();
});
