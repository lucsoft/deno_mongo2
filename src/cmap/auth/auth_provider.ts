import type { Document } from '../../bson.ts';
import { MongoRuntimeError } from '../../error.ts';
import type { Callback, ClientMetadataOptions } from '../../utils.ts';
import type { HandshakeDocument } from '../connect.ts';
import type { Connection, ConnectionOptions } from '../connection.ts';
import type { MongoCredentials } from './mongo_credentials.ts';

export type AuthContextOptions = ConnectionOptions & ClientMetadataOptions;

/** Context used during authentication */
export class AuthContext {
  /** The connection to authenticate */
  connection: Connection;
  /** The credentials to use for authentication */
  credentials?: MongoCredentials;
  /** The options passed to the `connect` method */
  options: AuthContextOptions;

  /** A response from an initial auth attempt, only some mechanisms use this (e.g, SCRAM) */
  response?: Document;
  /** A random nonce generated for use in an authentication conversation */
  nonce?: Buffer;

  constructor(
    connection: Connection,
    credentials: MongoCredentials | undefined,
    options: AuthContextOptions
  ) {
    this.connection = connection;
    this.credentials = credentials;
    this.options = options;
  }
}

export class AuthProvider {
  /**
   * Prepare the handshake document before the initial handshake.
   *
   * @param handshakeDoc - The document used for the initial handshake on a connection
   * @param authContext - Context for authentication flow
   */
  prepare(
    handshakeDoc: HandshakeDocument,
    authContext: AuthContext,
    callback: Callback<HandshakeDocument>
  ): void {
    callback(undefined, handshakeDoc);
  }

  /**
   * Authenticate
   *
   * @param context - A shared context for authentication flow
   * @param callback - The callback to return the result from the authentication
   */
  auth(context: AuthContext, callback: Callback): void {
    // TODO(NODE-3483): Replace this with MongoMethodOverrideError
    callback(new MongoRuntimeError('`auth` method must be overridden by subclass'));
  }
}
