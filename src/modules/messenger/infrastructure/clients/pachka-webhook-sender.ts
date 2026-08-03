export async function sendPachkaMessage(
  webhookUrl: string,
  message: string
): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Pachka webhook failed: ${res.status} ${body}`);
  }
}
