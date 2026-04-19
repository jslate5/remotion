import path from "node:path";
import { config as loadEnv } from "dotenv";
import { getDb, wipeAllRecords } from "./db";

loadEnv({ path: path.resolve(__dirname, "..", ".env") });

const db = getDb();
wipeAllRecords(db);
console.log("Database wiped: plans, templates, and clips are empty.");
