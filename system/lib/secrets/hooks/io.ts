// stdin/stdout plumbing shared by the secret hooks. Claude Code passes one JSON
// object on stdin per tool call; a hook answers on stdout (or prints nothing).

export interface HookInput {
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id?: string;
  tool_response?: unknown;
}

/** Parses a hook payload; throws on anything that is not a well-formed tool call. */
export function parseHookInput(raw: string): HookInput {
  const v: unknown = JSON.parse(raw);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error('hook input is not an object');
  }
  const o = v as Record<string, unknown>;
  const ti = o.tool_input;
  if (
    typeof o.session_id !== 'string' ||
    typeof o.tool_name !== 'string' ||
    typeof ti !== 'object' ||
    ti === null ||
    Array.isArray(ti)
  ) {
    throw new Error('hook input is missing session_id, tool_name or tool_input');
  }
  return o as unknown as HookInput;
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function readHookInput(): Promise<HookInput> {
  return parseHookInput(await readStdin());
}

export function emit(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
