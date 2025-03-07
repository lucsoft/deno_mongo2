import Denque from 'denque';
import type { Readable } from 'stream';

import type { Document, Long, Timestamp } from './bson.ts';
import { Collection } from './collection.ts';
import { CHANGE, CLOSE, END, ERROR, INIT, MORE, RESPONSE, RESUME_TOKEN_CHANGED } from './constants.ts';
import {
  AbstractCursor,
  AbstractCursorEvents,
  AbstractCursorOptions,
  CursorStreamOptions
} from './cursor/abstract_cursor.ts';
import { Db } from './db.ts';
import {
  AnyError,
  isResumableError,
  MongoAPIError,
  MongoChangeStreamError,
  MongoRuntimeError
} from './error.ts';
import { MongoClient } from './mongo_client.ts';
import { InferIdType, Nullable, TODO_NODE_3286, TypedEventEmitter } from './mongo_types.ts';
import { AggregateOperation, AggregateOptions } from './operations/aggregate.ts';
import type { CollationOptions, OperationParent } from './operations/command.ts';
import { executeOperation, ExecutionResult } from './operations/execute_operation.ts';
import type { ReadPreference } from './read_preference.ts';
import type { Topology } from './sdam/topology.ts';
import type { ClientSession } from './sessions.ts';
import {
  calculateDurationInMs,
  Callback,
  filterOptions,
  getTopology,
  maxWireVersion,
  maybePromise,
  MongoDBNamespace,
  now
} from './utils.ts';

/** @internal */
const kResumeQueue = Symbol('resumeQueue');
/** @internal */
const kCursorStream = Symbol('cursorStream');
/** @internal */
const kClosed = Symbol('closed');
/** @internal */
const kMode = Symbol('mode');

const CHANGE_STREAM_OPTIONS = [
  'resumeAfter',
  'startAfter',
  'startAtOperationTime',
  'fullDocument'
] as const;

const CURSOR_OPTIONS = [
  'batchSize',
  'maxAwaitTimeMS',
  'collation',
  'readPreference',
  'comment',
  ...CHANGE_STREAM_OPTIONS
] as const;

const CHANGE_DOMAIN_TYPES = {
  COLLECTION: Symbol('Collection'),
  DATABASE: Symbol('Database'),
  CLUSTER: Symbol('Cluster')
};

interface TopologyWaitOptions {
  start?: number;
  timeout?: number;
  readPreference?: ReadPreference;
}

const SELECTION_TIMEOUT = 30000;

const CHANGE_STREAM_EVENTS = [RESUME_TOKEN_CHANGED, END, CLOSE];

const NO_RESUME_TOKEN_ERROR =
  'A change stream document has been received that lacks a resume token (_id).';
const NO_CURSOR_ERROR = 'ChangeStream has no cursor';
const CHANGESTREAM_CLOSED_ERROR = 'ChangeStream is closed';

/** @public */
export interface ResumeOptions {
  startAtOperationTime?: Timestamp;
  batchSize?: number;
  maxAwaitTimeMS?: number;
  collation?: CollationOptions;
  readPreference?: ReadPreference;
  resumeAfter?: ResumeToken;
  startAfter?: ResumeToken;
}

/**
 * Represents the logical starting point for a new or resuming {@link https://docs.mongodb.com/manual/changeStreams/#std-label-change-stream-resume| Change Stream} on the server.
 * @public
 */
export type ResumeToken = unknown;

/**
 * Represents a specific point in time on a server. Can be retrieved by using {@link Db#command}
 * @public
 * @remarks
 * See {@link https://docs.mongodb.com/manual/reference/method/db.runCommand/#response| Run Command Response}
 */
export type OperationTime = Timestamp;

/** @public */
export interface PipeOptions {
  end?: boolean;
}

/** @internal */
export type ChangeStreamAggregateRawResult<TChange> = {
  $clusterTime: { clusterTime: Timestamp };
  cursor: {
    postBatchResumeToken: ResumeToken;
    ns: string;
    id: number | Long;
  } & ({ firstBatch: TChange[] } | { nextBatch: TChange[] });
  ok: 1;
  operationTime: Timestamp;
};

/**
 * Options that can be passed to a ChangeStream. Note that startAfter, resumeAfter, and startAtOperationTime are all mutually exclusive, and the server will error if more than one is specified.
 * @public
 */
export interface ChangeStreamOptions extends AggregateOptions {
  /** Allowed values: 'updateLookup'. When set to 'updateLookup', the change stream will include both a delta describing the changes to the document, as well as a copy of the entire document that was changed from some time after the change occurred. */
  fullDocument?: string;
  /** The maximum amount of time for the server to wait on new documents to satisfy a change stream query. */
  maxAwaitTimeMS?: number;
  /** Allows you to start a changeStream after a specified event. See {@link https://docs.mongodb.com/manual/changeStreams/#resumeafter-for-change-streams|ChangeStream documentation}. */
  resumeAfter?: ResumeToken;
  /** Similar to resumeAfter, but will allow you to start after an invalidated event. See {@link https://docs.mongodb.com/manual/changeStreams/#startafter-for-change-streams|ChangeStream documentation}. */
  startAfter?: ResumeToken;
  /** Will start the changeStream after the specified operationTime. */
  startAtOperationTime?: OperationTime;
  /** The number of documents to return per batch. See {@link https://docs.mongodb.com/manual/reference/command/aggregate|aggregation documentation}. */
  batchSize?: number;
}

/** @public */
export interface ChangeStreamDocument<TSchema extends Document = Document> {
  /**
   * The id functions as an opaque token for use when resuming an interrupted
   * change stream.
   */
  _id: InferIdType<TSchema>;

  /**
   * Describes the type of operation represented in this change notification.
   */
  operationType:
    | 'insert'
    | 'update'
    | 'replace'
    | 'delete'
    | 'invalidate'
    | 'drop'
    | 'dropDatabase'
    | 'rename';

  /**
   * Contains two fields: “db” and “coll” containing the database and
   * collection name in which the change happened.
   */
  ns: { db: string; coll: string };

  /**
   * Only present for ops of type ‘insert’, ‘update’, ‘replace’, and
   * ‘delete’.
   *
   * For unsharded collections this contains a single field, _id, with the
   * value of the _id of the document updated.  For sharded collections,
   * this will contain all the components of the shard key in order,
   * followed by the _id if the _id isn’t part of the shard key.
   */
  documentKey?: { _id: InferIdType<TSchema> };

  /**
   * Only present for ops of type ‘update’.
   *
   * Contains a description of updated and removed fields in this
   * operation.
   */
  updateDescription?: UpdateDescription<TSchema>;

  /**
   * Always present for operations of type ‘insert’ and ‘replace’. Also
   * present for operations of type ‘update’ if the user has specified ‘updateLookup’
   * in the ‘fullDocument’ arguments to the ‘$changeStream’ stage.
   *
   * For operations of type ‘insert’ and ‘replace’, this key will contain the
   * document being inserted, or the new version of the document that is replacing
   * the existing document, respectively.
   *
   * For operations of type ‘update’, this key will contain a copy of the full
   * version of the document from some point after the update occurred. If the
   * document was deleted since the updated happened, it will be null.
   */
  fullDocument?: TSchema;
}

/** @public */
export interface UpdateDescription<TSchema extends Document = Document> {
  /**
   * A document containing key:value pairs of names of the fields that were
   * changed, and the new value for those fields.
   */
  updatedFields: Partial<TSchema>;

  /**
   * An array of field names that were removed from the document.
   */
  removedFields: string[];
}

/** @public */
export type ChangeStreamEvents<TSchema extends Document = Document> = {
  resumeTokenChanged(token: ResumeToken): void;
  init(response: TSchema): void;
  more(response?: TSchema | undefined): void;
  response(): void;
  end(): void;
  error(error: Error): void;
  change(change: ChangeStreamDocument<TSchema>): void;
} & AbstractCursorEvents;

/**
 * Creates a new Change Stream instance. Normally created using {@link Collection#watch|Collection.watch()}.
 * @public
 */
export class ChangeStream<TSchema extends Document = Document> extends TypedEventEmitter<
  ChangeStreamEvents<TSchema>
> {
  pipeline: Document[];
  options: ChangeStreamOptions;
  parent: MongoClient | Db | Collection;
  namespace: MongoDBNamespace;
  type: symbol;
  /** @internal */
  cursor?: ChangeStreamCursor<TSchema>;
  streamOptions?: CursorStreamOptions;
  /** @internal */
  [kResumeQueue]: Denque<Callback<ChangeStreamCursor<TSchema>>>;
  /** @internal */
  [kCursorStream]?: Readable;
  /** @internal */
  [kClosed]: boolean;
  /** @internal */
  [kMode]: false | 'iterator' | 'emitter';

  /** @event */
  static readonly RESPONSE = RESPONSE;
  /** @event */
  static readonly MORE = MORE;
  /** @event */
  static readonly INIT = INIT;
  /** @event */
  static readonly CLOSE = CLOSE;
  /**
   * Fired for each new matching change in the specified namespace. Attaching a `change`
   * event listener to a Change Stream will switch the stream into flowing mode. Data will
   * then be passed as soon as it is available.
   * @event
   */
  static readonly CHANGE = CHANGE;
  /** @event */
  static readonly END = END;
  /** @event */
  static readonly ERROR = ERROR;
  /**
   * Emitted each time the change stream stores a new resume token.
   * @event
   */
  static readonly RESUME_TOKEN_CHANGED = 'resumeTokenChanged' as const;

  /**
   * @internal
   *
   * @param parent - The parent object that created this change stream
   * @param pipeline - An array of {@link https://docs.mongodb.com/manual/reference/operator/aggregation-pipeline/|aggregation pipeline stages} through which to pass change stream documents
   */
  constructor(
    parent: OperationParent,
    pipeline: Document[] = [],
    options: ChangeStreamOptions = {}
  ) {
    super();

    this.pipeline = pipeline;
    this.options = options;

    if (parent instanceof Collection) {
      this.type = CHANGE_DOMAIN_TYPES.COLLECTION;
    } else if (parent instanceof Db) {
      this.type = CHANGE_DOMAIN_TYPES.DATABASE;
    } else if (parent instanceof MongoClient) {
      this.type = CHANGE_DOMAIN_TYPES.CLUSTER;
    } else {
      throw new MongoChangeStreamError(
        'Parent provided to ChangeStream constructor must be an instance of Collection, Db, or MongoClient'
      );
    }

    this.parent = parent;
    this.namespace = parent.s.namespace;
    if (!this.options.readPreference && parent.readPreference) {
      this.options.readPreference = parent.readPreference;
    }

    this[kResumeQueue] = new Denque();

    // Create contained Change Stream cursor
    this.cursor = this._createChangeStreamCursor(options);

    this[kClosed] = false;
    this[kMode] = false;

    // Listen for any `change` listeners being added to ChangeStream
    this.on('newListener', eventName => {
      if (eventName === 'change' && this.cursor && this.listenerCount('change') === 0) {
        this._streamEvents(this.cursor);
      }
    });

    this.on('removeListener', eventName => {
      if (eventName === 'change' && this.listenerCount('change') === 0 && this.cursor) {
        this[kCursorStream]?.removeAllListeners('data');
      }
    });
  }

  /** @internal */
  get cursorStream(): Readable | undefined {
    return this[kCursorStream];
  }

  /** The cached resume token that is used to resume after the most recently returned change. */
  get resumeToken(): ResumeToken {
    return this.cursor?.resumeToken;
  }

  /** Check if there is any document still available in the Change Stream */
  hasNext(): Promise<boolean>;
  hasNext(callback: Callback<boolean>): void;
  hasNext(callback?: Callback): Promise<boolean> | void {
    this._setIsIterator();
    return maybePromise(callback, cb => {
      this._getCursor((err, cursor) => {
        if (err || !cursor) return cb(err); // failed to resume, raise an error
        cursor.hasNext(cb);
      });
    });
  }

  /** Get the next available document from the Change Stream. */
  next(): Promise<ChangeStreamDocument<TSchema>>;
  next(callback: Callback<ChangeStreamDocument<TSchema>>): void;
  next(
    callback?: Callback<ChangeStreamDocument<TSchema>>
  ): Promise<ChangeStreamDocument<TSchema>> | void {
    this._setIsIterator();
    return maybePromise(callback, cb => {
      this._getCursor((err, cursor) => {
        if (err || !cursor) return cb(err); // failed to resume, raise an error
        cursor.next((error, change) => {
          if (error) {
            this[kResumeQueue].push(() => this.next(cb));
            this._processError(error, cb);
            return;
          }
          this._processNewChange(change, cb);
        });
      });
    });
  }

  /** Is the cursor closed */
  get closed(): boolean {
    return this[kClosed] || (this.cursor?.closed ?? false);
  }

  /** Close the Change Stream */
  close(callback?: Callback): Promise<void> | void {
    this[kClosed] = true;

    return maybePromise(callback, cb => {
      if (!this.cursor) {
        return cb();
      }

      const cursor = this.cursor;
      return cursor.close(err => {
        this._endStream();
        this.cursor = undefined;
        return cb(err);
      });
    });
  }

  /**
   * Return a modified Readable stream including a possible transform method.
   * @throws MongoDriverError if this.cursor is undefined
   */
  stream(options?: CursorStreamOptions): Readable {
    this.streamOptions = options;
    if (!this.cursor) throw new MongoChangeStreamError(NO_CURSOR_ERROR);
    return this.cursor.stream(options);
  }

  /**
   * Try to get the next available document from the Change Stream's cursor or `null` if an empty batch is returned
   */
  tryNext(): Promise<Document | null>;
  tryNext(callback: Callback<Document | null>): void;
  tryNext(callback?: Callback<Document | null>): Promise<Document | null> | void {
    this._setIsIterator();
    return maybePromise(callback, cb => {
      this._getCursor((err, cursor) => {
        if (err || !cursor) return cb(err); // failed to resume, raise an error
        return cursor.tryNext(cb);
      });
    });
  }

  /** @internal */
  private _setIsEmitter(): void {
    if (this[kMode] === 'iterator') {
      // TODO(NODE-3485): Replace with MongoChangeStreamModeError
      throw new MongoAPIError(
        'ChangeStream cannot be used as an EventEmitter after being used as an iterator'
      );
    }
    this[kMode] = 'emitter';
  }

  /** @internal */
  private _setIsIterator(): void {
    if (this[kMode] === 'emitter') {
      // TODO(NODE-3485): Replace with MongoChangeStreamModeError
      throw new MongoAPIError(
        'ChangeStream cannot be used as an iterator after being used as an EventEmitter'
      );
    }
    this[kMode] = 'iterator';
  }

  /** @internal */
  private _createChangeStreamCursor(
    options: ChangeStreamOptions | ResumeOptions
  ): ChangeStreamCursor<TSchema> {
    const changeStreamStageOptions = filterOptions(options, CHANGE_STREAM_OPTIONS);
    if (this.type === CHANGE_DOMAIN_TYPES.CLUSTER) {
      changeStreamStageOptions.allChangesForCluster = true;
    }
    const pipeline = [{ $changeStream: changeStreamStageOptions }, ...this.pipeline];

    const cursorOptions: ChangeStreamCursorOptions = filterOptions(options, CURSOR_OPTIONS);

    const changeStreamCursor = new ChangeStreamCursor<TSchema>(
      getTopology(this.parent),
      this.namespace,
      pipeline,
      cursorOptions
    );

    for (const event of CHANGE_STREAM_EVENTS) {
      changeStreamCursor.on(event, e => this.emit(event, e));
    }

    if (this.listenerCount(ChangeStream.CHANGE) > 0) {
      this._streamEvents(changeStreamCursor);
    }

    return changeStreamCursor;
  }

  /**
   * This method performs a basic server selection loop, satisfying the requirements of
   * ChangeStream resumability until the new SDAM layer can be used.
   * @internal
   */
  private _waitForTopologyConnected(
    topology: Topology,
    options: TopologyWaitOptions,
    callback: Callback
  ) {
    setTimeout(() => {
      if (options && options.start == null) {
        options.start = now();
      }

      const start = options.start || now();
      const timeout = options.timeout || SELECTION_TIMEOUT;
      if (topology.isConnected()) {
        return callback();
      }

      if (calculateDurationInMs(start) > timeout) {
        // TODO(NODE-3497): Replace with MongoNetworkTimeoutError
        return callback(new MongoRuntimeError('Timed out waiting for connection'));
      }

      this._waitForTopologyConnected(topology, options, callback);
    }, 500); // this is an arbitrary wait time to allow SDAM to transition
  }

  /** @internal */
  private _closeWithError(error: AnyError, callback?: Callback): void {
    if (!callback) {
      this.emit(ChangeStream.ERROR, error);
    }

    this.close(() => callback && callback(error));
  }

  /** @internal */
  private _streamEvents(cursor: ChangeStreamCursor<TSchema>): void {
    this._setIsEmitter();
    const stream = this[kCursorStream] ?? cursor.stream();
    this[kCursorStream] = stream;
    stream.on('data', change => this._processNewChange(change));
    stream.on('error', error => this._processError(error));
  }

  /** @internal */
  private _endStream(): void {
    const cursorStream = this[kCursorStream];
    if (cursorStream) {
      ['data', 'close', 'end', 'error'].forEach(event => cursorStream.removeAllListeners(event));
      cursorStream.destroy();
    }

    this[kCursorStream] = undefined;
  }

  /** @internal */
  private _processNewChange(
    change: Nullable<ChangeStreamDocument<TSchema>>,
    callback?: Callback<ChangeStreamDocument<TSchema>>
  ) {
    if (this[kClosed]) {
      // TODO(NODE-3485): Replace with MongoChangeStreamClosedError
      if (callback) callback(new MongoAPIError(CHANGESTREAM_CLOSED_ERROR));
      return;
    }

    // a null change means the cursor has been notified, implicitly closing the change stream
    if (change == null) {
      // TODO(NODE-3485): Replace with MongoChangeStreamClosedError
      return this._closeWithError(new MongoRuntimeError(CHANGESTREAM_CLOSED_ERROR), callback);
    }

    if (change && !change._id) {
      return this._closeWithError(new MongoChangeStreamError(NO_RESUME_TOKEN_ERROR), callback);
    }

    // cache the resume token
    this.cursor?.cacheResumeToken(change._id);

    // wipe the startAtOperationTime if there was one so that there won't be a conflict
    // between resumeToken and startAtOperationTime if we need to reconnect the cursor
    this.options.startAtOperationTime = undefined;

    // Return the change
    if (!callback) return this.emit(ChangeStream.CHANGE, change);
    return callback(undefined, change);
  }

  /** @internal */
  private _processError(error: AnyError, callback?: Callback) {
    const cursor = this.cursor;

    // If the change stream has been closed explicitly, do not process error.
    if (this[kClosed]) {
      // TODO(NODE-3485): Replace with MongoChangeStreamClosedError
      if (callback) callback(new MongoAPIError(CHANGESTREAM_CLOSED_ERROR));
      return;
    }

    // if the resume succeeds, continue with the new cursor
    const resumeWithCursor = (newCursor: ChangeStreamCursor<TSchema>) => {
      this.cursor = newCursor;
      this._processResumeQueue();
    };

    // otherwise, raise an error and close the change stream
    const unresumableError = (err: AnyError) => {
      if (!callback) {
        this.emit(ChangeStream.ERROR, err);
      }

      this.close(() => this._processResumeQueue(err));
    };

    if (cursor && isResumableError(error, maxWireVersion(cursor.server))) {
      this.cursor = undefined;

      // stop listening to all events from old cursor
      this._endStream();

      // close internal cursor, ignore errors
      cursor.close();

      const topology = getTopology(this.parent);
      this._waitForTopologyConnected(topology, { readPreference: cursor.readPreference }, err => {
        // if the topology can't reconnect, close the stream
        if (err) return unresumableError(err);

        // create a new cursor, preserving the old cursor's options
        const newCursor = this._createChangeStreamCursor(cursor.resumeOptions);

        // attempt to continue in emitter mode
        if (!callback) return resumeWithCursor(newCursor);

        // attempt to continue in iterator mode
        newCursor.hasNext(err => {
          // if there's an error immediately after resuming, close the stream
          if (err) return unresumableError(err);
          resumeWithCursor(newCursor);
        });
      });
      return;
    }

    // if initial error wasn't resumable, raise an error and close the change stream
    return this._closeWithError(error, callback);
  }

  /**
   * Safely provides a cursor across resume attempts
   * @internal
   */
  private _getCursor(callback: Callback<ChangeStreamCursor<TSchema>>) {
    if (this[kClosed]) {
      // TODO(NODE-3485): Replace with MongoChangeStreamClosedError
      callback(new MongoAPIError(CHANGESTREAM_CLOSED_ERROR));
      return;
    }

    // if a cursor exists and it is open, return it
    if (this.cursor) {
      callback(undefined, this.cursor);
      return;
    }

    // no cursor, queue callback until topology reconnects
    this[kResumeQueue].push(callback);
  }

  /**
   * Drain the resume queue when a new has become available
   * @internal
   *
   * @param err - error getting a new cursor
   */
  private _processResumeQueue(err?: Error) {
    while (this[kResumeQueue].length) {
      const request = this[kResumeQueue].pop();
      if (!request) break; // Should never occur but TS can't use the length check in the while condition

      if (!err) {
        if (this[kClosed]) {
          // TODO(NODE-3485): Replace with MongoChangeStreamClosedError
          request(new MongoAPIError(CHANGESTREAM_CLOSED_ERROR));
          return;
        }
        if (!this.cursor) {
          request(new MongoChangeStreamError(NO_CURSOR_ERROR));
          return;
        }
      }
      request(err, this.cursor);
    }
  }
}

/** @internal */
export interface ChangeStreamCursorOptions extends AbstractCursorOptions {
  startAtOperationTime?: OperationTime;
  resumeAfter?: ResumeToken;
  startAfter?: ResumeToken;
}

/** @internal */
export class ChangeStreamCursor<TSchema extends Document = Document> extends AbstractCursor<
  ChangeStreamDocument<TSchema>,
  ChangeStreamEvents
> {
  _resumeToken: ResumeToken;
  startAtOperationTime?: OperationTime;
  hasReceived?: boolean;
  resumeAfter: ResumeToken;
  startAfter: ResumeToken;
  options: ChangeStreamCursorOptions;

  postBatchResumeToken?: ResumeToken;
  pipeline: Document[];

  constructor(
    topology: Topology,
    namespace: MongoDBNamespace,
    pipeline: Document[] = [],
    options: ChangeStreamCursorOptions = {}
  ) {
    super(topology, namespace, options);

    this.pipeline = pipeline;
    this.options = options;
    this._resumeToken = null;
    this.startAtOperationTime = options.startAtOperationTime;

    if (options.startAfter) {
      this.resumeToken = options.startAfter;
    } else if (options.resumeAfter) {
      this.resumeToken = options.resumeAfter;
    }
  }

  set resumeToken(token: ResumeToken) {
    this._resumeToken = token;
    this.emit(ChangeStream.RESUME_TOKEN_CHANGED, token);
  }

  get resumeToken(): ResumeToken {
    return this._resumeToken;
  }

  get resumeOptions(): ResumeOptions {
    const result: ResumeOptions = filterOptions(this.options, CURSOR_OPTIONS);

    if (this.resumeToken || this.startAtOperationTime) {
      for (const key of ['resumeAfter', 'startAfter', 'startAtOperationTime']) {
        Reflect.deleteProperty(result, key);
      }

      if (this.resumeToken) {
        const resumeKey =
          this.options.startAfter && !this.hasReceived ? 'startAfter' : 'resumeAfter';

        result[resumeKey] = this.resumeToken;
      } else if (this.startAtOperationTime && maxWireVersion(this.server) >= 7) {
        result.startAtOperationTime = this.startAtOperationTime;
      }
    }

    return result;
  }

  cacheResumeToken(resumeToken: ResumeToken): void {
    if (this.bufferedCount() === 0 && this.postBatchResumeToken) {
      this.resumeToken = this.postBatchResumeToken;
    } else {
      this.resumeToken = resumeToken;
    }
    this.hasReceived = true;
  }

  /** TODO(NODE-4059): Use TChange */
  _processBatch(response: ChangeStreamAggregateRawResult<any>): void {
    const cursor = response.cursor;
    if (cursor.postBatchResumeToken) {
      this.postBatchResumeToken = cursor.postBatchResumeToken;

      const batch =
        'firstBatch' in response.cursor ? response.cursor.firstBatch : response.cursor.nextBatch;
      if (batch.length === 0) {
        this.resumeToken = cursor.postBatchResumeToken;
      }
    }
  }

  clone(): AbstractCursor<ChangeStreamDocument<TSchema>> {
    return new ChangeStreamCursor(this.topology, this.namespace, this.pipeline, {
      ...this.cursorOptions
    });
  }

  _initialize(session: ClientSession, callback: Callback<ExecutionResult>): void {
    const aggregateOperation = new AggregateOperation(this.namespace, this.pipeline, {
      ...this.cursorOptions,
      ...this.options,
      session
    });

    /* TODO(NODE4059): Use TChange instead of any */
    executeOperation<TODO_NODE_3286, ChangeStreamAggregateRawResult<any>>(
      session,
      aggregateOperation,
      (err, response) => {
        if (err || response == null) {
          return callback(err);
        }

        const server = aggregateOperation.server;
        if (
          this.startAtOperationTime == null &&
          this.resumeAfter == null &&
          this.startAfter == null &&
          maxWireVersion(server) >= 7
        ) {
          this.startAtOperationTime = response.operationTime;
        }

        this._processBatch(response);

        this.emit(ChangeStream.INIT, response);
        this.emit(ChangeStream.RESPONSE);

        // TODO: NODE-2882
        callback(undefined, { server, session, response });
      }
    );
  }

  override _getMore(batchSize: number, callback: Callback): void {
    super._getMore(batchSize, (err, response) => {
      if (err) {
        return callback(err);
      }

      // TODO(NODE-4059): Use TChange
      this._processBatch(response as TODO_NODE_3286 as ChangeStreamAggregateRawResult<any>);

      this.emit(ChangeStream.MORE, response);
      this.emit(ChangeStream.RESPONSE);
      callback(err, response);
    });
  }
}
