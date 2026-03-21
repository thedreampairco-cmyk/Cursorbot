import dotenv from "dotenv";

dotenv.config();

const requiredEnvVars = [
  "PORT",
  "GREEN_API_INSTANCE_ID",
  "GREEN_API_TOKEN",
  "GROQ_API_KEY",
  "MONGO_URI",
];

requiredEnvVars.forEach((key) => {
  if (!process.env[key]) {
    console.error(`❌ Missing required environment variable: ${key}`);
    process.exit(1);
  }
});

export const ENV = {
  PORT: process.env.PORT,
  GREEN_API_INSTANCE_ID: process.env.GREEN_API_INSTANCE_ID,
  GREEN_API_TOKEN: process.env.GREEN_API_TOKEN,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  MONGO_URI: process.env.MONGO_URI,
};
