import { defineConfig } from "vite";
import { cpSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Copies three's Draco / Basis decoders to public/decoders so
// DRACOLoader.setDecoderPath("decoders/draco/") and KTX2Loader
// .setTranscoderPath("decoders/basis/") resolve, matching the Tesana build.
function decoders() {
  return {
    name: "tesana-decoders",
    buildStart() {
      const here = dirname(fileURLToPath(import.meta.url));
      const src = resolve(here, "node_modules/three/examples/jsm/libs");
      for (const d of ["draco", "basis"]) {
        const from = resolve(src, d);
        if (existsSync(from)) cpSync(from, resolve(here, "public/decoders", d), { recursive: true });
      }
    },
  };
}

export default defineConfig({ base: "./", plugins: [decoders()], build: { target: "es2022", sourcemap: false } });
