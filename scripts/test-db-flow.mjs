import { createPostgresStore, createPostgresStatusClient, createPostgresAdminClient, getPostgresPool } from "../src/lib/registration/postgres-store.ts";

async function run() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  
  const store = createPostgresStore();
  const statusClient = createPostgresStatusClient();
  const adminClient = createPostgresAdminClient();

  const testKey = "test-idemp-" + Date.now();
  const testRecord = {
    registrationDate: "2026-10-20",
    fullName: "Priya Sharma",
    dateOfBirth: "1994-05-15",
    gender: "female",
    phone: "+919876543210",
    address: {
      line1: "123 Anna Salai",
      city: "Chennai",
      state: "Tamil Nadu",
      postalCode: "600002"
    },
    concerns: ["pregnancy", "vbac"],
    sources: ["doctor"],
    consent: true,
    signature: {
      type: "typed",
      name: "Priya Sharma"
    }
  };

  console.log("1. Testing save() to Railway Postgres...");
  const receipt = await store.save(testRecord, { idempotencyKey: testKey, clinicId: "main" });
  console.log("-> Saved successfully! Receipt:", receipt);

  console.log("2. Testing fetchStatus() with token...");
  const status = await statusClient.fetchStatus(receipt.token);
  console.log("-> Status result:", status);

  console.log("3. Testing admin list()...");
  const entries = await adminClient.list("main", receipt.clinicDate);
  console.log("-> Admin entries count:", entries.length);
  console.log("-> Latest entry:", entries[entries.length - 1]);

  console.log("4. Testing admin update() state -> waiting...");
  const updated = await adminClient.update(receipt.id, "waiting");
  console.log("-> Updated entry:", updated);

  const pool = getPostgresPool();
  if (pool) await pool.end();

  console.log("\nALL RAILWAY DB TESTS PASSED SUCCESSFULLY! 🎉");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
