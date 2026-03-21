require("dotenv").config();

const GROQ_API_KEY = process.env.GROQ_API_KEY;

if (!GROQ_API_KEY) {
  console.error("❌ Missing GROQ_API_KEY in .env");
  process.exit(1);
}

module.exports = {
  GROQ_API_KEY,
};
