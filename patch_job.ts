async function main() {
  const res = await fetch('http://localhost:3000/api/jobs/8e8de00e-ff23-498e-84b0-49076256f032', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'applied', luckyStatus: 'none' })
  });
  console.log('Status:', res.status);
  console.log('Body:', await res.json());
}
main();
