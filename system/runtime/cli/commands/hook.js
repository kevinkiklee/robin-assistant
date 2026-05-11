export async function hook(argv) {
  const phase = argv[0];
  const { DISPATCH, runHook } = await import('../../../io/hooks/dispatcher.js');
  if (!phase || !DISPATCH[phase]) {
    console.error(`unknown hook phase: ${phase ?? ''}`);
    process.exit(1);
  }
  await runHook(phase);
}
