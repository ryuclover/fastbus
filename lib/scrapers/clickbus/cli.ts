import { mapClickbus } from "./mapper";

// Compatibility entry point; shares provider cooldown and the bounded browser diagnostic.
void mapClickbus(undefined, undefined, process.argv[2]).catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Falha na observação.",
  );
  process.exitCode = 1;
});
