/** Waits until the stack answers (the API starts after Postgres and the migrations). */
export default async function waitForApi(): Promise<void> {
  const url = `${process.env.E2E_API_URL ?? 'http://localhost:3100'}/v1/openapi.json`;
  const deadline = Date.now() + 150_000;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`The API did not come up at ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
