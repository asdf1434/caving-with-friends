/* ============================================================
   CACHE STAMPING

   Adds "?v=<version>" to every file the browser loads as code.

   GitHub Pages sends "cache-control: max-age=600" on everything
   and gives no way to change it, so a returning player can be
   holding an old copy. A URL the browser has not seen before
   has to be fetched, which also rules out the worse case of new
   code running against a module left over from a previous
   deploy.

   The word lists are left alone on purpose. They are 4.3MB and
   effectively never change, so stamping them would turn every
   deploy into a fresh download for no benefit.

   Run from the repository root, against a checkout that is
   about to be published:

       node deploy/stamp.mjs <version>

   It rewrites public/ in place, so it is meant for CI rather
   than for a working copy.
   ============================================================ */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";


const version = process.argv[2];

if (!version || !/^[A-Za-z0-9._-]+$/.test(version)) {
    console.error("usage: node deploy/stamp.mjs <version>");
    process.exit(1);
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "public");


function fail(message) {
    console.error(`stamp: ${message}`);
    process.exit(1);
}


/* Returns how many references it stamped. */

function rewrite(file, pattern, replacement) {

    const full = path.join(PUBLIC_DIR, file);
    const before = fs.readFileSync(full, "utf8");

    const count = (before.match(pattern) || []).length;

    if (count === 0) {
        return 0;
    }

    fs.writeFileSync(full, before.replace(pattern, replacement));

    console.log(`  ${file}: ${count} reference${count === 1 ? "" : "s"}`);

    return count;
}


/* ------------------------------------------------------------
   The stylesheet and the entry module, referenced from the page

   Both must match. A rename that quietly stopped one of these
   from matching would ship a build that looked fine and served
   a stale file weeks later.
   ------------------------------------------------------------ */

const styles = rewrite(
    "index.html",
    /href="(css\/style\.css)"/g,
    `href="$1?v=${version}"`
);

if (styles === 0) {
    fail('index.html does not link href="css/style.css"');
}

const entry = rewrite(
    "index.html",
    /src="(js\/main\.js)"/g,
    `src="$1?v=${version}"`
);

if (entry === 0) {
    fail('index.html does not load src="js/main.js"');
}


/* ------------------------------------------------------------
   Imports between the modules

   The browser resolves these against the importing module's
   URL, so stamping the entry point alone would not reach them.

   Not every module imports something — config.js and engine.js
   stand alone — so no single file is required to match. What
   matters is that none are left behind, which is checked below.
   ------------------------------------------------------------ */

const IMPORT = /from "(\.\/[^"]+\.js)"/g;

let imports = 0;

const modules = fs.readdirSync(path.join(PUBLIC_DIR, "js"))
    .filter(name => name.endsWith(".js"));

for (const name of modules) {
    imports += rewrite(path.join("js", name), IMPORT, `from "$1?v=${version}"`);
}

if (imports === 0) {
    fail("no imports were stamped, which cannot be right");
}


/* Nothing may be left pointing at an unstamped module. */

for (const name of modules) {

    const body = fs.readFileSync(path.join(PUBLIC_DIR, "js", name), "utf8");
    const missed = body.match(IMPORT);

    if (missed) {
        fail(`js/${name} still imports ${missed.join(", ")}`);
    }
}


console.log(
    `\nstamped ${styles + entry + imports} references with ${version}`
);
