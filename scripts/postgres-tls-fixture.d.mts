export function createPostgresTlsFixture(options?: { network?: string; name?: string }): {
  name: string;
  volume: string;
  url: string;
  caFile: string;
  untrustedCaFile: string;
  close(): void;
};
