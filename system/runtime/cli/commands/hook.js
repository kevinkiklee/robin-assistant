export async function hook(argv) {
  const phase = argv[0];
  const { DISPATCH, runHook } = await import('../../../io/hooks/dispatcher.js');
  if (!phase || !DISPATCH[phase]) {
    const known = Object.keys(DISPATCH).sort().join(', ');
    console.error(
      phase
        ? `unknown hook phase: ${phase}. known phases: ${known}`
        : `missing hook phase. usage: robin hook <${known.replace(/, /g, '|')}>`,
    );
    process.exit(1);
  }
  await runHook(phase);
}
