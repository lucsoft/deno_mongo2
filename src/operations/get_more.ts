import type { Document, Long } from '../bson.ts';
import { MongoRuntimeError } from '../error.ts';
import type { Server } from '../sdam/server.ts';
import type { ClientSession } from '../sessions.ts';
import { Callback, maxWireVersion, MongoDBNamespace } from '../utils.ts';
import { AbstractOperation, Aspect, defineAspects, OperationOptions } from './operation.ts';

/**
 * @public
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export interface GetMoreOptions extends OperationOptions {
  /** Set the batchSize for the getMoreCommand when iterating over the query results. */
  batchSize?: number;
  /**
   * Comment to apply to the operation.
   *
   * getMore only supports 'comment' in server versions 4.4 and above.
   */
  comment?: unknown;
  /** Number of milliseconds to wait before aborting the query. */
  maxTimeMS?: number;
}

/** @internal */
export class GetMoreOperation extends AbstractOperation {
  cursorId: Long;
  override options: GetMoreOptions;

  constructor(ns: MongoDBNamespace, cursorId: Long, server: Server, options: GetMoreOptions = {}) {
    super(options);

    this.options = options;

    // comment on getMore is only supported for server versions 4.4 and above
    if (maxWireVersion(server) < 9) {
      delete this.options.comment;
    }

    this.ns = ns;
    this.cursorId = cursorId;
    this.server = server;
  }

  /**
   * Although there is a server already associated with the get more operation, the signature
   * for execute passes a server so we will just use that one.
   */
  override execute(
    server: Server,
    session: ClientSession | undefined,
    callback: Callback<Document>
  ): void {
    if (server !== this.server) {
      return callback(
        new MongoRuntimeError('Getmore must run on the same server operation began on')
      );
    }
    server.getMore(this.ns, this.cursorId, this.options, callback);
  }
}

defineAspects(GetMoreOperation, [Aspect.READ_OPERATION, Aspect.CURSOR_ITERATING]);
