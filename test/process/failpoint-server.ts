import { buildApplication, type ApplicationContext } from "../../src/app";
import { DELIVERY_CHECKPOINTS, type DeliveryCheckpoint, type DeliveryFailpoints } from "../../src/application/quote-v2/delivery/delivery-failpoints";
import {
  ISSUANCE_CHECKPOINTS,
  type IssuanceCheckpoint,
  type IssuanceFailpoints
} from "../../src/application/quote-v2/issuance-failpoints";
import { loadEnv } from "../../src/infrastructure/config/env";
import { GmailMailSender } from "../../src/infrastructure/email/gmail-mail-sender";

/*
 * TEST-ONLY service entry for the R1.5B4 / R1.6B crash harnesses. It lives
 * under test/ (never compiled into dist/, never in the runtime image) and is
 * the only composition that passes `issuanceFailpoints`, `deliveryFailpoints`
 * or a provider endpoint to buildApplication.
 *
 *   node --import tsx test/process/failpoint-server.ts [--halt=<checkpoint>] [--suspend-renewals]
 *        [--delivery-halt=<checkpoint>] [--fake-mail-provider=<http://127.0.0.1:port>]
 *
 * --halt=<checkpoint>  the first time the issuance checkpoint is reached,
 *                      print {"event":"failpoint.reached",...} on stdout and
 *                      HOLD (await forever). The parent test then kills the
 *                      process with SIGKILL (no finally block, no shutdown
 *                      hook, no failure write can run), or writes "resume\n"
 *                      on stdin to let it continue (zombie scenarios).
 * --suspend-renewals   while held, every lease renewal is held too: the
 *                      process behaves like a suspended (SIGSTOP'd) holder
 *                      whose lease expires in the database.
 * --delivery-halt=<checkpoint>  the same for the first delivery checkpoint
 *                      (marker event "delivery_failpoint.reached").
 * --fake-mail-provider=<url>    compose the REAL Gmail adapter pointed at a
 *                      local fake provider (`<url>/token`, `<url>/send`)
 *                      that runs in the PARENT test process, so its call
 *                      count survives this process's SIGKILL. Never Gmail.
 *
 * Configuration comes from the environment exactly like src/server.ts; the
 * failpoint and provider selection come only from this file's argv.
 */

const argValue = (name: string): string | undefined =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

const haltAt = argValue("halt") as IssuanceCheckpoint | undefined;
const deliveryHaltAt = argValue("delivery-halt") as DeliveryCheckpoint | undefined;
const fakeMailProvider = argValue("fake-mail-provider");
const suspendRenewals = process.argv.includes("--suspend-renewals");

if (haltAt !== undefined && !(ISSUANCE_CHECKPOINTS as readonly string[]).includes(haltAt)) {
  process.stderr.write(`unknown checkpoint ${haltAt}\n`);
  process.exit(64);
}

if (deliveryHaltAt !== undefined && !(DELIVERY_CHECKPOINTS as readonly string[]).includes(deliveryHaltAt)) {
  process.stderr.write(`unknown delivery checkpoint ${deliveryHaltAt}\n`);
  process.exit(64);
}

if (fakeMailProvider !== undefined && !/^http:\/\/127\.0\.0\.1:\d+$/.test(fakeMailProvider)) {
  process.stderr.write("the fake mail provider must be a loopback http URL\n");
  process.exit(64);
}

const marker = (payload: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(payload)}\n`);

let halted = false;
let deliveryHalted = false;
let resumed = false;
let resume!: () => void;
const resumedPromise = new Promise<void>((resolve) => {
  resume = () => {
    resumed = true;
    resolve();
  };
});

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  if (chunk.includes("resume")) {
    marker({ event: "failpoint.resumed" });
    resume();
  }
});

const failpoints: IssuanceFailpoints = {
  async reach(checkpoint, context) {
    // The storage readiness probe also links (probe files): not a publication.
    if (checkpoint === "before_artifact_link" && context.detail?.startsWith("probe-")) {
      return;
    }

    if (checkpoint === haltAt && !halted) {
      halted = true;
      marker({ event: "failpoint.reached", checkpoint, ...context, pid: process.pid });
      await resumedPromise;
      return;
    }

    if (checkpoint === "lease_renewal" && suspendRenewals && halted && !resumed) {
      marker({ event: "failpoint.renewal_held", ...context });
      await resumedPromise;
    }
  }
};

const deliveryFailpoints: DeliveryFailpoints = {
  async reach(checkpoint, context) {
    if (checkpoint === deliveryHaltAt && !deliveryHalted) {
      deliveryHalted = true;
      marker({ event: "delivery_failpoint.reached", checkpoint, ...context, pid: process.pid });
      await resumedPromise;
    }
  }
};

let application: ApplicationContext | null = null;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void (application ? application.shutdown(signal) : Promise.resolve("completed")).then((outcome) => process.exit(outcome === "completed" ? 0 : 1));
  });
}

async function main(): Promise<void> {
  const env = loadEnv();
  const testMailSender = fakeMailProvider
    ? new GmailMailSender({
        clientId: "crash-client-id",
        clientSecret: "crash-client-secret",
        refreshToken: "crash-refresh-token",
        from: { address: "cotizaciones@pesaschile.cl", name: "Pesas Chile" },
        replyTo: null,
        tokenTimeoutMs: env.QUOTE_EMAIL_TOKEN_TIMEOUT_MS,
        sendTimeoutMs: env.QUOTE_EMAIL_SEND_TIMEOUT_MS,
        endpoints: { token: `${fakeMailProvider}/token`, send: `${fakeMailProvider}/send` }
      })
    : undefined;
  application = buildApplication(env, {
    issuanceFailpoints: failpoints,
    deliveryFailpoints,
    ...(testMailSender ? { testMailSender } : {})
  });
  const url = await application.app.listen({ host: env.HOST, port: env.PORT });
  marker({ event: "failpoint_server.listening", url, pid: process.pid, haltAt: haltAt ?? null, deliveryHaltAt: deliveryHaltAt ?? null });
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ event: "failpoint_server.fatal", errorName: error instanceof Error ? error.name : "unknown" })}\n`);
  process.exit(1);
});
