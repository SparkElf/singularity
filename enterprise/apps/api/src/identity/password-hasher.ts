import { hash, verify, type Algorithm } from "@node-rs/argon2";

export interface ArgonDriver {
  hash(password: string): Promise<string>;
  verify(digest: string, password: string): Promise<boolean>;
}

export interface KdfAdmissionOptions {
  maximumActive: number;
  maximumQueued: number;
  waitTimeoutMilliseconds: number;
}

export class KdfAdmissionError extends Error {
  readonly retryAfter = 1;

  constructor() {
    super("Password hashing capacity is unavailable");
    this.name = "KdfAdmissionError";
  }
}

const ARGON_OPTIONS = {
  algorithm: 2 as Algorithm,
  memoryCost: 65_536,
  outputLen: 32,
  parallelism: 1,
  timeCost: 3,
} as const;

const DEFAULT_ADMISSION_OPTIONS: KdfAdmissionOptions = {
  maximumActive: 2,
  maximumQueued: 8,
  waitTimeoutMilliseconds: 5_000,
};

const nodeArgonDriver: ArgonDriver = {
  hash: async (password) => hash(password, ARGON_OPTIONS),
  verify: async (digest, password) => verify(digest, password, ARGON_OPTIONS),
};

interface QueueEntry<T> {
  reject: (error: KdfAdmissionError) => void;
  resolve: (value: T) => void;
  run: () => Promise<T>;
  timer: NodeJS.Timeout;
}

export class PasswordHasher {
  readonly #driver: ArgonDriver;
  readonly #options: KdfAdmissionOptions;
  readonly #queue: QueueEntry<unknown>[] = [];
  #dummyDigest: Promise<string> | undefined;
  #active = 0;

  constructor(
    driver: ArgonDriver = nodeArgonDriver,
    options: KdfAdmissionOptions = DEFAULT_ADMISSION_OPTIONS,
  ) {
    if (
      options.maximumActive < 1 ||
      options.maximumQueued < 0 ||
      options.waitTimeoutMilliseconds < 1
    ) {
      throw new TypeError("Invalid password hashing admission options");
    }

    this.#driver = driver;
    this.#options = options;
  }

  get activeCount(): number {
    return this.#active;
  }

  get queuedCount(): number {
    return this.#queue.length;
  }

  hashPassword(password: string): Promise<string> {
    return this.#execute(() => this.#driver.hash(password));
  }

  async initialize(): Promise<void> {
    await this.#getDummyDigest();
  }

  async #getDummyDigest(): Promise<string> {
    this.#dummyDigest ??= this.#execute(() =>
      this.#driver.hash("singularity-dummy-password-v1"),
    );
    return this.#dummyDigest;
  }

  verifyPassword(digest: string, password: string): Promise<boolean> {
    return this.#execute(() => this.#driver.verify(digest, password));
  }

  async verifyDummy(password: string): Promise<void> {
    const digest = await this.#getDummyDigest();
    await this.#execute(() => this.#driver.verify(digest, password));
  }

  #execute<T>(run: () => Promise<T>): Promise<T> {
    if (this.#active < this.#options.maximumActive) {
      return this.#start(run);
    }

    if (this.#queue.length >= this.#options.maximumQueued) {
      return Promise.reject(new KdfAdmissionError());
    }

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = {
        reject,
        resolve,
        run,
        timer: setTimeout(() => {
          const index = this.#queue.indexOf(entry as QueueEntry<unknown>);
          if (index >= 0) {
            this.#queue.splice(index, 1);
            reject(new KdfAdmissionError());
          }
        }, this.#options.waitTimeoutMilliseconds),
      };
      this.#queue.push(entry as QueueEntry<unknown>);
    });
  }

  async #start<T>(run: () => Promise<T>): Promise<T> {
    this.#active += 1;
    try {
      return await run();
    } finally {
      this.#active -= 1;
      this.#drain();
    }
  }

  #drain(): void {
    while (
      this.#active < this.#options.maximumActive &&
      this.#queue.length > 0
    ) {
      const entry = this.#queue.shift();
      if (entry === undefined) {
        return;
      }

      clearTimeout(entry.timer);
      void this.#start(entry.run).then(entry.resolve, entry.reject);
    }
  }
}
