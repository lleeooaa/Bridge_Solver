import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const manifestUrl = new URL("../public/dds/manifest.json", import.meta.url);
const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));
for (const [name, expected] of Object.entries(manifest.files)) {
    const actual = createHash("sha256").update(readFileSync(new URL(name, manifestUrl))).digest("hex");
    if (actual !== expected) throw new Error(`DDS asset checksum mismatch: ${name}. Restore the pinned asset or deliberately update its provenance.`);
}
console.log(`Verified DDS assets at upstream revision ${manifest.revision}.`);
