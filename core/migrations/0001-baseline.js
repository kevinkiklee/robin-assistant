export const id = '0001-baseline';
export const description = 'v3.0.0 baseline marker — no-op for fresh installs';

export async function up({ workspaceDir, helpers }) {
  // Intentional no-op. This migration's existence marks v3.0.0 as the
  // baseline. Future migrations build on it (0002-..., 0003-...).
}
