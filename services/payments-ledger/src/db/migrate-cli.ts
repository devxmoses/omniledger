import { migrate } from "./migrate.js";

const url = process.env.DATABASE_URL;
if(!url) throw new Error("DATABASE_URL is not set");

await migrate(url);
