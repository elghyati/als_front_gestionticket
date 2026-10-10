/** Writes the Postman collection and environments into `postman/`. */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildCollection, COLLECTION_FILE, environments } from "./postman";

const root = new URL("../", import.meta.url);
const outDir = fileURLToPath(new URL("postman/", root));
const write = (file: string, data: unknown) => {
  writeFileSync(outDir + file, JSON.stringify(data, null, 2) + "\n");
  console.log(`postman/${file}`);
};

mkdirSync(outDir, { recursive: true });
write(COLLECTION_FILE, await buildCollection(fileURLToPath(new URL("openapi/openapi.yaml", root))));
for (const [file, env] of Object.entries(environments)) write(file, env);
