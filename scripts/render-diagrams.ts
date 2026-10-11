/**
 * Renders every Mermaid diagram of docs/api/FLOWS.md to SVG and PNG in
 * docs/api/diagrams/, named after its section (e.g. 03-kiosque-retrait.svg).
 *
 *   npm run docs:diagrams
 *
 * Uses @mermaid-js/mermaid-cli through npx (downloaded on first run, with its
 * own Chromium). To reuse an installed browser, point PUPPETEER_CONFIG to a
 * puppeteer config file such as {"executablePath": "…/chrome"}.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "docs/api/FLOWS.md");
const outDir = join(root, "docs/api/diagrams");

const slug = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

interface Diagram {
  name: string;
  title: string;
  code: string;
}

/** Each ```mermaid block, named after the "## N. Title" section it belongs to. */
function extract(markdown: string): Diagram[] {
  const diagrams: Diagram[] = [];
  let section = { number: "00", title: "intro" };
  const perSection = new Map<string, Diagram[]>();
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i]!.match(/^## (\d+)\. (.+)$/);
    if (heading) section = { number: heading[1]!.padStart(2, "0"), title: heading[2]! };
    if (lines[i] !== "```mermaid") continue;
    const end = lines.indexOf("```", i + 1);
    const diagram = { name: "", title: section.title, code: lines.slice(i + 1, end).join("\n") + "\n" };
    const key = section.number;
    perSection.set(key, [...(perSection.get(key) ?? []), diagram]);
    diagram.name = `${key}-${slug(section.title)}`;
    diagrams.push(diagram);
    i = end;
  }
  // Several diagrams in one section: suffix a, b, c…
  for (const group of perSection.values()) {
    if (group.length > 1) group.forEach((d, i) => (d.name += `-${String.fromCharCode(97 + i)}`));
  }
  return diagrams;
}

function render(input: string, output: string, extra: string[]) {
  const args = ["-y", "@mermaid-js/mermaid-cli@11", "-i", input, "-o", output, "-b", "white", "-q", ...extra];
  if (process.env.PUPPETEER_CONFIG) args.push("-p", process.env.PUPPETEER_CONFIG);
  const result = spawnSync("npx", args, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error(`mermaid-cli failed on ${input}`);
}

const diagrams = extract(readFileSync(source, "utf8"));
mkdirSync(outDir, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "diagrams-"));
try {
  for (const d of diagrams) {
    const input = join(work, `${d.name}.mmd`);
    writeFileSync(input, d.code);
    render(input, join(outDir, `${d.name}.svg`), []);
    render(input, join(outDir, `${d.name}.png`), ["-w", "1600", "-s", "2"]);
    console.log(`docs/api/diagrams/${d.name}.svg|.png`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

const index = [
  "# Schémas exportés",
  "",
  "Images générées depuis [`../FLOWS.md`](../FLOWS.md) par `npm run docs:diagrams`. Ne pas modifier à la main.",
  "SVG : net à toute taille (Word, PowerPoint, navigateur). PNG : pour les outils qui n'acceptent pas le SVG.",
  "",
  "| Schéma | SVG | PNG |",
  "|---|---|---|",
  ...diagrams.map((d) => `| ${d.name} — ${d.title} | [SVG](${d.name}.svg) | [PNG](${d.name}.png) |`),
  "",
];
writeFileSync(join(outDir, "README.md"), index.join("\n"));
console.log(`${diagrams.length} diagrams rendered`);
