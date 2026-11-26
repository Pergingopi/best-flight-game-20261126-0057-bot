// Meridian Courier — the program that hands the game in.
//
// The game itself is the static files under game/ in this repository:
// game/index.html and its ES modules, no library, no network request —
// a desktop browser plays it straight off disk. This file is only the
// courier: it stages a copy of game/ and screenshots/ into the output
// folder and writes the dossier the judge reads, using the vendored
// make.fun library (vendor/makefun-game.ts — the kit's copy, untouched).
//
// Play it locally first with `node serve.ts`, then open
// http://localhost:8080. Outside the grader's container the output
// folder is wherever MAKEFUN_OUTPUT_DIR points:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

/** The repository's own directory: the game and the screenshots live beside this file. */
const repoRoot = fileURLToPath(new URL('.', import.meta.url));

/** Where the entry goes: /output in the grader, or MAKEFUN_OUTPUT_DIR elsewhere. */
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/**
 * The scorer's caps, passed through so this program fails exactly where
 * the scorer would. Only text_max_bytes shapes the bytes; the rest refuse
 * an entry the scorer would refuse: more than 4 screenshots or one over
 * 256 KiB, more than 993 files in game/ or 48 MiB of game files in all,
 * or a path under game/ over 1000 bytes.
 */
const DOSSIER_CAPS = {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
  game_path_max_bytes: 1000,
};

/**
 * Empty a directory's contents without removing the directory itself.
 * The grader mounts the output folder, so deleting the mount point
 * itself would fail — only what is inside it goes.
 */
function emptyDirectory(dir) {
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) {
    rmSync(join(dir, name), { recursive: true, force: true });
  }
}

/**
 * Stage the entry's files: the whole game/ tree, then the screenshots
 * beside it (when the screenshots folder exists at all).
 */
function stageEntryFiles(from, to) {
  cpSync(join(from, 'game'), join(to, 'game'), { recursive: true });
  mkdirSync(join(to, 'screenshots'), { recursive: true });
  if (existsSync(join(from, 'screenshots'))) {
    cpSync(join(from, 'screenshots'), join(to, 'screenshots'), { recursive: true });
  }
}

/** Build the dossier from the staged files and write it as dossier.json. */
function writeDossier(dir) {
  writeFileSync(join(dir, 'dossier.json'), buildDossier(dir, DOSSIER_CAPS));
}

/**
 * Open up every staged file for reading. The grader reads the output as
 * a different user, so a file left behind by a secure temporary file
 * (mode 0600) would lock it out: directories become 0755, files 0644.
 */
function relaxPermissions(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      chmodSync(path, 0o755);
      relaxPermissions(path);
    } else {
      chmodSync(path, 0o644);
    }
  }
}

/** Hand the entry in: clear the output, stage the files, describe them, open them up. */
function handIn() {
  emptyDirectory(outputDir);
  stageEntryFiles(repoRoot, outputDir);
  writeDossier(outputDir);
  relaxPermissions(outputDir);
}

handIn();
