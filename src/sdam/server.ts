import type { Document, Long } from '../bson.ts';
import { CommandOptions, Connection, DestroyOptions, GetMoreOptions } from '../cmap/connection.ts';
import {
  ConnectionPool,
  ConnectionPoolEvents,
  ConnectionPoolOptions
} from '../cmap/connection_pool.ts';
import {
  APM_EVENTS,
  CLOSED,
  CMAP_EVENTS,
  CONNECT,
  DESCRIPTION_RECEIVED,
  ENDED,
  HEARTBEAT_EVENTS,
  SERVER_HEARTBEAT_FAILED,
  SERVER_HEARTBEAT_STARTED,
  SERVER_HEARTBEAT_SUCCEEDED
} from '../constants.ts';
import type { AutoEncrypter } from '../deps.ts';
import {
  isNetworkErrorBeforeHandshake,
  isNodeShuttingDownError,
  isSDAMUnrecoverableError,
  MongoCompatibilityError,
  MongoError,
  MongoErrorLabel,
  MongoInvalidArgumentError,
  MongoNetworkError,
  MongoNetworkTimeoutError,
  MongoServerClosedError,
  MongoUnexpectedServerResponseError,
  needsRetryableWriteLabel
} from '../error.ts';
import { Logger } from '../logger.ts';
import type { ServerApi } from '../mongo_client.ts';
import { TypedEventEmitter } from '../mongo_types.ts';
import type { ClientSession } from '../sessions.ts';
import { isTransactionCommand } from '../transactions.ts';
import {
  Callback,
  collationNotSupported,
  EventEmitterWithState,
  makeStateMachine,
  maxWireVersion,
  MongoDBNamespace,
  supportsRetryableWrites
} from '../utils.ts';
import {
  ClusterTime,
  STATE_CLOSED,
  STATE_CLOSING,
  STATE_CONNECTED,
  STATE_CONNECTING,
  TopologyType
} from './common.ts';
import type {
  ServerHeartbeatFailedEvent,
  ServerHeartbeatStartedEvent,
  ServerHeartbeatSucceededEvent
} from './events.ts';
import { Monitor, MonitorOptions } from './monitor.ts';
import { compareTopologyVersion, ServerDescription } from './server_description.ts';
import type { Topology } from './topology.ts';
import { nextTick } from 'next-tick';

const stateTransition = makeStateMachine({
  [STATE_CLOSED]: [STATE_CLOSED, STATE_CONNECTING],
  [STATE_CONNECTING]: [STATE_CONNECTING, STATE_CLOSING, STATE_CONNECTED, STATE_CLOSED],
  [STATE_CONNECTED]: [STATE_CONNECTED, STATE_CLOSING, STATE_CLOSED],
  [STATE_CLOSING]: [STATE_CLOSING, STATE_CLOSED]
});

/** @internal */
const kMonitor = Symbol('monitor');

/** @public */
export type ServerOptions = Omit<ConnectionPoolOptions, 'id' | 'generation' | 'hostAddress'> &
  MonitorOptions;

/** @internal */
export interface ServerPrivate {
  /** The server description for this server */
  description: ServerDescription;
  /** A copy of the options used to construct this instance */
  options: ServerOptions;
  /** A logger instance */
  logger: Logger;
  /** The current state of the Server */
  state: string;
  /** The topology this server is a part of */
  topology: Topology;
  /** A connection pool for this server */
  pool: ConnectionPool;
  /** MongoDB server API version */
  serverApi?: ServerApi;
  /** A count of the operations currently running against the server. */
  operationCount: number;
}

/** @public */
export type ServerEvents = {
  serverHeartbeatStarted(event: ServerHeartbeatStartedEvent): void;
  serverHeartbeatSucceeded(event: ServerHeartbeatSucceededEvent): void;
  serverHeartbeatFailed(event: ServerHeartbeatFailedEvent): void;
  /** Top level MongoClient doesn't emit this so it is marked: @internal */
  connect(server: Server): void;
  descriptionReceived(description: ServerDescription): void;
  closed(): void;
  ended(): void;
} & ConnectionPoolEvents &
  EventEmitterWithState;

/** @internal */
export class Server extends TypedEventEmitter<ServerEvents> {
  /** @internal */
  s: ServerPrivate;
  serverApi?: ServerApi;
  hello?: Document;
  [kMonitor]: Monitor | null;

  /** @event */
  static readonly SERVER_HEARTBEAT_STARTED = SERVER_HEARTBEAT_STARTED;
  /** @event */
  static readonly SERVER_HEARTBEAT_SUCCEEDED = SERVER_HEARTBEAT_SUCCEEDED;
  /** @event */
  static readonly SERVER_HEARTBEAT_FAILED = SERVER_HEARTBEAT_FAILED;
  /** @event */
  static readonly CONNECT = CONNECT;
  /** @event */
  static readonly DESCRIPTION_RECEIVED = DESCRIPTION_RECEIVED;
  /** @event */
  static readonly CLOSED = CLOSED;
  /** @event */
  static readonly ENDED = ENDED;

  /**
   * Create a server
   */
  constructor(topology: Topology, description: ServerDescription, options: ServerOptions) {
    super();

    this.serverApi = options.serverApi;

    const poolOptions = { hostAddress: description.hostAddress, ...options };

    this.s = {
      description,
      options,
      logger: new Logger('Server'),
      state: STATE_CLOSED,
      topology,
      pool: new ConnectionPool(poolOptions),
      operationCount: 0
    };

    for (const event of [...CMAP_EVENTS, ...APM_EVENTS]) {
      this.s.pool.on(event, (e: any) => this.emit(event, e));
    }

    this.s.pool.on(Connection.CLUSTER_TIME_RECEIVED, (clusterTime: ClusterTime) => {
      this.clusterTime = clusterTime;
    });

    if (this.loadBalanced) {
      this[kMonitor] = null;
      // monitoring is disabled in load balancing mode
      return;
    }

    // create the monitor
    // TODO(NODE-4144): Remove new variable for type narrowing
    const monitor = new Monitor(this, this.s.options);
    this[kMonitor] = monitor;

    for (const event of HEARTBEAT_EVENTS) {
      monitor.on(event, (e: any) => this.emit(event, e));
    }

    monitor.on('resetConnectionPool', () => {
      this.s.pool.clear();
    });

    monitor.on('resetServer', (error: MongoError) => markServerUnknown(this, error));
    monitor.on(Server.SERVER_HEARTBEAT_SUCCEEDED, (event: ServerHeartbeatSucceededEvent) => {
      this.emit(
        Server.DESCRIPTION_RECEIVED,
        new ServerDescription(this.description.hostAddress, event.reply, {
          roundTripTime: calculateRoundTripTime(this.description.roundTripTime, event.duration)
        })
      );

      if (this.s.state === STATE_CONNECTING) {
        stateTransition(this, STATE_CONNECTED);
        this.emit(Server.CONNECT, this);
      }
    });
  }

  get clusterTime(): ClusterTime | undefined {
    return this.s.topology.clusterTime;
  }

  set clusterTime(clusterTime: ClusterTime | undefined) {
    this.s.topology.clusterTime = clusterTime;
  }

  get description(): ServerDescription {
    return this.s.description;
  }

  get name(): string {
    return this.s.description.address;
  }

  get autoEncrypter(): AutoEncrypter | undefined {
    if (this.s.options && this.s.options.autoEncrypter) {
      return this.s.options.autoEncrypter;
    }
    return;
  }

  get loadBalanced(): boolean {
    return this.s.topology.description.type === TopologyType.LoadBalanced;
  }

  /**
   * Initiate server connect
   */
  connect(): void {
    if (this.s.state !== STATE_CLOSED) {
      return;
    }

    stateTransition(this, STATE_CONNECTING);

    // If in load balancer mode we automatically set the server to
    // a load balancer. It never transitions out of this state and
    // has no monitor.
    if (!this.loadBalanced) {
      this[kMonitor]?.connect();
    } else {
      stateTransition(this, STATE_CONNECTED);
      this.emit(Server.CONNECT, this);
    }
  }

  /** Destroy the server connection */
  destroy(options?: DestroyOptions, callback?: Callback): void {
    if (typeof options === 'function') (callback = options), (options = {});
    options = Object.assign({}, { force: false }, options);

    if (this.s.state === STATE_CLOSED) {
      if (typeof callback === 'function') {
        callback();
      }

      return;
    }

    stateTransition(this, STATE_CLOSING);

    if (!this.loadBalanced) {
      this[kMonitor]?.close();
    }

    this.s.pool.close(options, err => {
      stateTransition(this, STATE_CLOSED);
      this.emit('closed');
      if (typeof callback === 'function') {
        callback(err);
      }
    });
  }

  /**
   * Immediately schedule monitoring of this server. If there already an attempt being made
   * this will be a no-op.
   */
  requestCheck(): void {
    if (!this.loadBalanced) {
      this[kMonitor]?.requestCheck();
    }
  }

  /**
   * Execute a command
   * @internal
   */
  command(
    ns: MongoDBNamespace,
    cmd: Document,
    options: CommandOptions,
    callback: Callback<Document>
  ): void {
    if (callback == null) {
      throw new MongoInvalidArgumentError('Callback must be provided');
    }

    if (ns.db == null || typeof ns === 'string') {
      throw new MongoInvalidArgumentError('Namespace must not be a string');
    }

    if (this.s.state === STATE_CLOSING || this.s.state === STATE_CLOSED) {
      callback(new MongoServerClosedError());
      return;
    }

    // Clone the options
    const finalOptions = Object.assign({}, options, { wireProtocolCommand: false });

    // There are cases where we need to flag the read preference not to get sent in
    // the command, such as pre-5.0 servers attempting to perform an aggregate write
    // with a non-primary read preference. In this case the effective read preference
    // (primary) is not the same as the provided and must be removed completely.
    if (finalOptions.omitReadPreference) {
      delete finalOptions.readPreference;
    }

    // error if collation not supported
    if (collationNotSupported(this, cmd)) {
      callback(new MongoCompatibilityError(`Server ${this.name} does not support collation`));
      return;
    }

    const session = finalOptions.session;
    const conn = session?.pinnedConnection;

    // NOTE: This is a hack! We can't retrieve the connections used for executing an operation
    //       (and prevent them from being checked back in) at the point of operation execution.
    //       This should be considered as part of the work for NODE-2882
    // NOTE:
    //       When incrementing operation count, it's important that we increment it before we
    //       attempt to check out a connection from the pool.  This ensures that operations that
    //       are waiting for a connection are included in the operation count.  Load balanced
    //       mode will only ever have a single server, so the operation count doesn't matter.
    //       Incrementing the operation count above the logic to handle load balanced mode would
    //       require special logic to decrement it again, or would double increment (the load
    //       balanced code makes a recursive call).  Instead, we increment the count after this
    //       check.
    if (this.loadBalanced && session && conn == null && isPinnableCommand(cmd, session)) {
      this.s.pool.checkOut((err, checkedOut) => {
        if (err || checkedOut == null) {
          if (callback) return callback(err);
          return;
        }

        session.pin(checkedOut);
        this.command(ns, cmd, finalOptions, callback);
      });
      return;
    }

    this.s.operationCount += 1;

    this.s.pool.withConnection(
      conn,
      (err, conn, cb) => {
        if (err || !conn) {
          this.s.operationCount -= 1;
          markServerUnknown(this, err);
          return cb(err);
        }

        conn.command(
          ns,
          cmd,
          finalOptions,
          makeOperationHandler(this, conn, cmd, finalOptions, (error, response) => {
            this.s.operationCount -= 1;
            cb(error, response);
          })
        );
      },
      callback
    );
  }

  /**
   * Execute a `getMore` against the server
   * @internal
   */
  getMore(
    ns: MongoDBNamespace,
    cursorId: Long,
    options: GetMoreOptions,
    callback: Callback<Document>
  ): void {
    if (this.s.state === STATE_CLOSING || this.s.state === STATE_CLOSED) {
      callback(new MongoServerClosedError());
      return;
    }

    this.s.operationCount += 1;

    this.s.pool.withConnection(
      options.session?.pinnedConnection,
      (err, conn, cb) => {
        if (err || !conn) {
          this.s.operationCount -= 1;
          markServerUnknown(this, err);
          return cb(err);
        }

        conn.getMore(
          ns,
          cursorId,
          options,
          makeOperationHandler(this, conn, {}, options, (error, response) => {
            this.s.operationCount -= 1;
            cb(error, response);
          })
        );
      },
      callback
    );
  }

  /**
   * Execute a `killCursors` command against the server
   * @internal
   */
  killCursors(
    ns: MongoDBNamespace,
    cursorIds: Long[],
    options: CommandOptions,
    callback?: Callback
  ): void {
    if (this.s.state === STATE_CLOSING || this.s.state === STATE_CLOSED) {
      if (typeof callback === 'function') {
        callback(new MongoServerClosedError());
      }

      return;
    }

    this.s.operationCount += 1;
    this.s.pool.withConnection(
      options.session?.pinnedConnection,
      (err, conn, cb) => {
        if (err || !conn) {
          this.s.operationCount -= 1;
          markServerUnknown(this, err);
          return cb(err);
        }

        conn.killCursors(
          ns,
          cursorIds,
          options,
          makeOperationHandler(this, conn, {}, undefined, (error, response) => {
            this.s.operationCount -= 1;
            cb(error, response);
          })
        );
      },
      callback
    );
  }
}

function calculateRoundTripTime(oldRtt: number, duration: number): number {
  if (oldRtt === -1) {
    return duration;
  }

  const alpha = 0.2;
  return alpha * duration + (1 - alpha) * oldRtt;
}

function markServerUnknown(server: Server, error?: MongoError) {
  // Load balancer servers can never be marked unknown.
  if (server.loadBalanced) {
    return;
  }

  if (error instanceof MongoNetworkError && !(error instanceof MongoNetworkTimeoutError)) {
    server[kMonitor]?.reset();
  }

  server.emit(
    Server.DESCRIPTION_RECEIVED,
    new ServerDescription(server.description.hostAddress, undefined, {
      error,
      topologyVersion:
        error && error.topologyVersion ? error.topologyVersion : server.description.topologyVersion
    })
  );
}

function isPinnableCommand(cmd: Document, session?: ClientSession): boolean {
  if (session) {
    return (
      session.inTransaction() ||
      'aggregate' in cmd ||
      'find' in cmd ||
      'getMore' in cmd ||
      'listCollections' in cmd ||
      'listIndexes' in cmd
    );
  }

  return false;
}

function connectionIsStale(pool: ConnectionPool, connection: Connection) {
  if (connection.serviceId) {
    return (
      connection.generation !== pool.serviceGenerations.get(connection.serviceId.toHexString())
    );
  }

  return connection.generation !== pool.generation;
}

function shouldHandleStateChangeError(server: Server, err: MongoError) {
  const etv = err.topologyVersion;
  const stv = server.description.topologyVersion;
  return compareTopologyVersion(stv, etv) < 0;
}

function inActiveTransaction(session: ClientSession | undefined, cmd: Document) {
  return session && session.inTransaction() && !isTransactionCommand(cmd);
}

/** this checks the retryWrites option passed down from the client options, it
 * does not check if the server supports retryable writes */
function isRetryableWritesEnabled(topology: Topology) {
  return topology.s.options.retryWrites !== false;
}

function makeOperationHandler(
  server: Server,
  connection: Connection,
  cmd: Document,
  options: CommandOptions | GetMoreOptions | undefined,
  callback: Callback
): Callback {
  const session = options?.session;
  return function handleOperationResult(error, result) {
    if (result != null) {
      return callback(undefined, result);
    }

    if (!error) {
      return callback(new MongoUnexpectedServerResponseError('Empty response with no error'));
    }

    if (!(error instanceof MongoError)) {
      // Node.js or some other error we have not special handling for
      return callback(error);
    }

    if (connectionIsStale(server.s.pool, connection)) {
      return callback(error);
    }

    if (error instanceof MongoNetworkError) {
      if (session && !session.hasEnded && session.serverSession) {
        session.serverSession.isDirty = true;
      }

      // inActiveTransaction check handles commit and abort.
      if (
        inActiveTransaction(session, cmd) &&
        !error.hasErrorLabel(MongoErrorLabel.TransientTransactionError)
      ) {
        error.addErrorLabel(MongoErrorLabel.TransientTransactionError);
      }

      if (
        (isRetryableWritesEnabled(server.s.topology) || isTransactionCommand(cmd)) &&
        supportsRetryableWrites(server) &&
        !inActiveTransaction(session, cmd)
      ) {
        error.addErrorLabel(MongoErrorLabel.RetryableWriteError);
      }

      if (!(error instanceof MongoNetworkTimeoutError) || isNetworkErrorBeforeHandshake(error)) {
        // In load balanced mode we never mark the server as unknown and always
        // clear for the specific service id.

        server.s.pool.clear(connection.serviceId);
        if (!server.loadBalanced) {
          markServerUnknown(server, error);
        }
      }
    } else {
      if (
        (isRetryableWritesEnabled(server.s.topology) || isTransactionCommand(cmd)) &&
        needsRetryableWriteLabel(error, maxWireVersion(server)) &&
        !inActiveTransaction(session, cmd)
      ) {
        error.addErrorLabel(MongoErrorLabel.RetryableWriteError);
      }

      if (isSDAMUnrecoverableError(error)) {
        if (shouldHandleStateChangeError(server, error)) {
          if (maxWireVersion(server) <= 7 || isNodeShuttingDownError(error)) {
            server.s.pool.clear(connection.serviceId);
          }

          if (!server.loadBalanced) {
            markServerUnknown(server, error);
            nextTick(() => server.requestCheck());
          }
        }
      }
    }

    if (
      session &&
      session.isPinned &&
      error.hasErrorLabel(MongoErrorLabel.TransientTransactionError)
    ) {
      session.unpin({ force: true });
    }

    return callback(error);
  };
}
