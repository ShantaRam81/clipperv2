import { ensureStorage, handleRequest } from "../src/server/app.js";

export default async function handler(req, res) {
  await ensureStorage();
  return handleRequest(req, res);
}
