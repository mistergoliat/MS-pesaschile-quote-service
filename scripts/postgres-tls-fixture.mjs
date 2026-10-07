import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Disposable test-only CA and PostgreSQL. Private keys never leave the Docker volume.
export function createPostgresTlsFixture({ network, name = `quote-tls-${crypto.randomBytes(5).toString("hex")}` } = {}) {
  const volume = `${name}-certificates`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quote-tls-"));
  const docker = (args) => execFileSync("docker", args, { encoding: "utf8", timeout: 180_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const close = () => {
    for (const args of [["rm", "-f", name], ["volume", "rm", "-f", volume]]) {
      try { docker(args); } catch { /* Startup may have failed before resource creation. */ }
    }
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("quote-tls-")) throw new Error("Unexpected fixture path");
    fs.rmSync(directory, { recursive: true, force: true });
  };
  try {
    docker(["volume", "create", volume]);
    docker(["run", "--rm", "-v", `${volume}:/certs`, "--entrypoint", "sh", "postgres:16-alpine", "-ec", `
apk add --no-cache openssl >/dev/null
cd /certs
umask 077
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 2 -subj /CN=Quote-Test-CA -addext basicConstraints=critical,CA:TRUE 2>/dev/null
openssl req -x509 -newkey rsa:2048 -nodes -keyout other.key -out other.crt -days 2 -subj /CN=Quote-Untrusted-Test-CA -addext basicConstraints=critical,CA:TRUE 2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj /CN=localhost 2>/dev/null
printf 'subjectAltName=DNS:localhost,DNS:${name}\\nbasicConstraints=critical,CA:FALSE\\nextendedKeyUsage=serverAuth\\n' > server.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 2 -extfile server.ext 2>/dev/null
rm ca.key other.key server.csr server.ext ca.srl
chmod 644 ca.crt other.crt server.crt
chown 70:70 server.key
chmod 600 server.key
`]);
    docker(["run", "-d", "--name", name, ...(network ? ["--network", network] : []), "-p", "127.0.0.1::5432", "--health-cmd", "pg_isready -U postgres -d quote_smoke", "--health-interval", "1s", "--health-timeout", "5s", "--health-retries", "30", "-v", `${volume}:/certs:ro`, "-e", "POSTGRES_PASSWORD=fixture-only", "-e", "POSTGRES_DB=quote_smoke", "postgres:16-alpine", "postgres", "-c", "ssl=on", "-c", "ssl_cert_file=/certs/server.crt", "-c", "ssl_key_file=/certs/server.key"]);
    docker(["cp", `${name}:/certs/ca.crt`, path.join(directory, "ca.crt")]);
    docker(["cp", `${name}:/certs/other.crt`, path.join(directory, "other.crt")]);
    const port = Number(docker(["port", name, "5432/tcp"]).split(":").at(-1));
    return { name, volume, url: `postgres://postgres:fixture-only@localhost:${port}/quote_smoke`, caFile: path.join(directory, "ca.crt"), untrustedCaFile: path.join(directory, "other.crt"), close };
  } catch (error) {
    close();
    // Docker failures can contain command arguments; callers receive a fixed diagnostic.
    throw new Error("Local PostgreSQL TLS fixture could not start", { cause: error });
  }
}
