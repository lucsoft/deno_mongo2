/* eslint-disable @typescript-eslint/no-var-requires */
import type { deserialize, Document, serialize } from './bson.ts';
import type { ProxyOptions } from './cmap/connection.ts';
import { MongoMissingDependencyError } from './error.ts';
import type { MongoClient } from './mongo_client.ts';
import { Callback, parsePackageVersion } from './utils.ts';

export const PKG_VERSION = Symbol('kPkgVersion');

function makeErrorModule(error: any) {
  const props = error ? { kModuleError: error } : {};
  return new Proxy(props, {
    get: (_: any, key: any) => {
      if (key === 'kModuleError') {
        return error;
      }
      throw error;
    },
    set: () => {
      throw error;
    }
  });
}

export interface KerberosClient {
  step: (challenge: string, callback?: Callback<string>) => Promise<string> | void;
  wrap: (
    challenge: string,
    options?: { user: string },
    callback?: Callback<string>
  ) => Promise<string> | void;
  unwrap: (challenge: string, callback?: Callback<string>) => Promise<string> | void;
}

type SnappyLib = {
  [PKG_VERSION]: { major: number; minor: number; patch: number };

  /**
   * - Snappy 6.x takes a callback and returns void
   * - Snappy 7.x returns a promise
   *
   * In order to support both we must check the return value of the function
   * @param buf - Buffer to be compressed
   * @param callback - ONLY USED IN SNAPPY 6.x
   */
  compress(buf: Buffer): Promise<Buffer>;
  compress(buf: Buffer, callback: (error?: Error, buffer?: Buffer) => void): Promise<Buffer> | void;
  compress(
    buf: Buffer,
    callback?: (error?: Error, buffer?: Buffer) => void
  ): Promise<Buffer> | void;

  /**
   * - Snappy 6.x takes a callback and returns void
   * - Snappy 7.x returns a promise
   *
   * In order to support both we must check the return value of the function
   * @param buf - Buffer to be compressed
   * @param callback - ONLY USED IN SNAPPY 6.x
   */
  uncompress(buf: Buffer, opt: { asBuffer: true }): Promise<Buffer>;
  uncompress(
    buf: Buffer,
    opt: { asBuffer: true },
    callback: (error?: Error, buffer?: Buffer) => void
  ): Promise<Buffer> | void;
  uncompress(
    buf: Buffer,
    opt: { asBuffer: true },
    callback?: (error?: Error, buffer?: Buffer) => void
  ): Promise<Buffer> | void;
};


interface AWS4 {
  /**
   * Created these inline types to better assert future usage of this API
   * @param options - options for request
   * @param credentials - AWS credential details, sessionToken should be omitted entirely if its false-y
   */
  sign(
    options: {
      path: '/';
      body: string;
      host: string;
      method: 'POST';
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded';
        'Content-Length': number;
        'X-MongoDB-Server-Nonce': string;
        'X-MongoDB-GS2-CB-Flag': 'n';
      };
      service: string;
      region: string;
    },
    credentials:
      | {
          accessKeyId: string;
          secretAccessKey: string;
          sessionToken: string;
        }
      | {
          accessKeyId: string;
          secretAccessKey: string;
        }
      | undefined
  ): {
    headers: {
      Authorization: string;
      'X-Amz-Date': string;
    };
  };
}

export let aws4: AWS4 | { kModuleError: MongoMissingDependencyError } = makeErrorModule(
  new MongoMissingDependencyError(
    'Optional module `aws4` not found. Please install it to enable AWS authentication'
  )
);

/** @public */
export const AutoEncryptionLoggerLevel = Object.freeze({
  FatalError: 0,
  Error: 1,
  Warning: 2,
  Info: 3,
  Trace: 4
} as const);

/** @public */
export type AutoEncryptionLoggerLevel =
  typeof AutoEncryptionLoggerLevel[keyof typeof AutoEncryptionLoggerLevel];

/** @public */
export interface AutoEncryptionTlsOptions {
  /**
   * Specifies the location of a local .pem file that contains
   * either the client's TLS/SSL certificate and key or only the
   * client's TLS/SSL key when tlsCertificateFile is used to
   * provide the certificate.
   */
  tlsCertificateKeyFile?: string;
  /**
   * Specifies the password to de-crypt the tlsCertificateKeyFile.
   */
  tlsCertificateKeyFilePassword?: string;
  /**
   * Specifies the location of a local .pem file that contains the
   * root certificate chain from the Certificate Authority.
   * This file is used to validate the certificate presented by the
   * KMS provider.
   */
  tlsCAFile?: string;
}

/** @public */
export interface AutoEncryptionOptions {
  /** @internal */
  bson?: { serialize: typeof serialize; deserialize: typeof deserialize };
  /** @internal client for metadata lookups */
  metadataClient?: MongoClient;
  /** A `MongoClient` used to fetch keys from a key vault */
  keyVaultClient?: MongoClient;
  /** The namespace where keys are stored in the key vault */
  keyVaultNamespace?: string;
  /** Configuration options that are used by specific KMS providers during key generation, encryption, and decryption. */
  kmsProviders?: {
    /** Configuration options for using 'aws' as your KMS provider */
    aws?: {
      /** The access key used for the AWS KMS provider */
      accessKeyId: string;
      /** The secret access key used for the AWS KMS provider */
      secretAccessKey: string;
      /**
       * An optional AWS session token that will be used as the
       * X-Amz-Security-Token header for AWS requests.
       */
      sessionToken?: string;
    };
    /** Configuration options for using 'local' as your KMS provider */
    local?: {
      /**
       * The master key used to encrypt/decrypt data keys.
       * A 96-byte long Buffer or base64 encoded string.
       */
      key: Buffer | string;
    };
    /** Configuration options for using 'azure' as your KMS provider */
    azure?: {
      /** The tenant ID identifies the organization for the account */
      tenantId: string;
      /** The client ID to authenticate a registered application */
      clientId: string;
      /** The client secret to authenticate a registered application */
      clientSecret: string;
      /**
       * If present, a host with optional port. E.g. "example.com" or "example.com:443".
       * This is optional, and only needed if customer is using a non-commercial Azure instance
       * (e.g. a government or China account, which use different URLs).
       * Defaults to "login.microsoftonline.com"
       */
      identityPlatformEndpoint?: string | undefined;
    };
    /** Configuration options for using 'gcp' as your KMS provider */
    gcp?: {
      /** The service account email to authenticate */
      email: string;
      /** A PKCS#8 encrypted key. This can either be a base64 string or a binary representation */
      privateKey: string | Buffer;
      /**
       * If present, a host with optional port. E.g. "example.com" or "example.com:443".
       * Defaults to "oauth2.googleapis.com"
       */
      endpoint?: string | undefined;
    };
    /**
     * Configuration options for using 'kmip' as your KMS provider
     */
    kmip?: {
      /**
       * The output endpoint string.
       * The endpoint consists of a hostname and port separated by a colon.
       * E.g. "example.com:123". A port is always present.
       */
      endpoint?: string;
    };
  };
  /**
   * A map of namespaces to a local JSON schema for encryption
   *
   * **NOTE**: Supplying options.schemaMap provides more security than relying on JSON Schemas obtained from the server.
   * It protects against a malicious server advertising a false JSON Schema, which could trick the client into sending decrypted data that should be encrypted.
   * Schemas supplied in the schemaMap only apply to configuring automatic encryption for client side encryption.
   * Other validation rules in the JSON schema will not be enforced by the driver and will result in an error.
   */
  schemaMap?: Document;
  /** @experimental */
  encryptedFieldsMap?: Document;
  /** Allows the user to bypass auto encryption, maintaining implicit decryption */
  bypassAutoEncryption?: boolean;
  /** @experimental */
  bypassQueryAnalysis?: boolean;
  options?: {
    /** An optional hook to catch logging messages from the underlying encryption engine */
    logger?: (level: AutoEncryptionLoggerLevel, message: string) => void;
  };
  extraOptions?: {
    /**
     * A local process the driver communicates with to determine how to encrypt values in a command.
     * Defaults to "mongodb://%2Fvar%2Fmongocryptd.sock" if domain sockets are available or "mongodb://localhost:27020" otherwise
     */
    mongocryptdURI?: string;
    /** If true, autoEncryption will not attempt to spawn a mongocryptd before connecting  */
    mongocryptdBypassSpawn?: boolean;
    /** The path to the mongocryptd executable on the system */
    mongocryptdSpawnPath?: string;
    /** Command line arguments to use when auto-spawning a mongocryptd */
    mongocryptdSpawnArgs?: string[];
    /**
     * Full path to a CSFLE shared library to be used (instead of mongocryptd).
     *
     * This needs to be the path to the file itself, not a directory.
     * It can be an absolute or relative path. If the path is relative and
     * its first component is `$ORIGIN`, it will be replaced by the directory
     * containing the mongodb-client-encryption native addon file. Otherwise,
     * the path will be interpreted relative to the current working directory.
     *
     * Currently, loading different CSFLE shared library files from different
     * MongoClients in the same process is not supported.
     *
     * If this option is provided and no CSFLE shared library could be loaded
     * from the specified location, creating the MongoClient will fail.
     *
     * If this option is not provided and `csfleRequired` is not specified,
     * the AutoEncrypter will attempt to spawn and/or use mongocryptd according
     * to the mongocryptd-specific `extraOptions` options.
     *
     * Specifying a path prevents mongocryptd from being used as a fallback.
     */
    csflePath?: string;
    /**
     * If specified, never use mongocryptd and instead fail when the CSFLE shared library
     * could not be loaded.
     *
     * This is always true when `csflePath` is specified.
     */
    csfleRequired?: boolean;
    /**
     * Search paths for a CSFLE shared library to be used (instead of mongocryptd)
     * Only for driver testing!
     * @internal
     */
    csfleSearchPaths?: string[];
  };
  proxyOptions?: ProxyOptions;
  /** The TLS options to use connecting to the KMS provider */
  tlsOptions?: {
    aws?: AutoEncryptionTlsOptions;
    local?: AutoEncryptionTlsOptions;
    azure?: AutoEncryptionTlsOptions;
    gcp?: AutoEncryptionTlsOptions;
    kmip?: AutoEncryptionTlsOptions;
  };
}

/** @public */
export interface AutoEncrypter {
  // eslint-disable-next-line @typescript-eslint/no-misused-new
  new (client: MongoClient, options: AutoEncryptionOptions): AutoEncrypter;
  init(cb: Callback): void;
  teardown(force: boolean, callback: Callback): void;
  encrypt(ns: string, cmd: Document, options: any, callback: Callback<Document>): void;
  decrypt(cmd: Document, options: any, callback: Callback<Document>): void;
  readonly csfleVersionInfo: { version: bigint; versionStr: string } | null;
}
