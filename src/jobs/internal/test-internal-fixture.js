// Internal-runtime job fixture used by the job-runner tests. The runner passes
// { db, host, capture, tools }; documenting the full signature here so future
// internal-job authors don't have to read the runner source to learn the API.
export default async function testInternalFixture({ db, host, capture, tools }) {
  return 'from internal fixture';
}
