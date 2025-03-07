import type { Document } from '../bson.ts';
import type { Collection } from '../collection.ts';
import type { MongoServerError } from '../error.ts';
import type { Server } from '../sdam/server.ts';
import type { ClientSession } from '../sessions.ts';
import { Callback, maxWireVersion } from '../utils.ts';
import { CommandOperation, CommandOperationOptions } from './command.ts';
import { Aspect, defineAspects } from './operation.ts';

/** @public */
export interface EstimatedDocumentCountOptions extends CommandOperationOptions {
  /**
   * The maximum amount of time to allow the operation to run.
   *
   * This option is sent only if the caller explicitly provides a value. The default is to not send a value.
   */
  maxTimeMS?: number;
}

/** @internal */
export class EstimatedDocumentCountOperation extends CommandOperation<number> {
  override options: EstimatedDocumentCountOptions;
  collectionName: string;

  constructor(collection: Collection, options: EstimatedDocumentCountOptions = {}) {
    super(collection, options);
    this.options = options;
    this.collectionName = collection.collectionName;
  }

  override execute(
    server: Server,
    session: ClientSession | undefined,
    callback: Callback<number>
  ): void {
    if (maxWireVersion(server) < 12) {
      return this.executeLegacy(server, session, callback);
    }
    const pipeline = [{ $collStats: { count: {} } }, { $group: { _id: 1, n: { $sum: '$count' } } }];

    const cmd: Document = { aggregate: this.collectionName, pipeline, cursor: {} };

    if (typeof this.options.maxTimeMS === 'number') {
      cmd.maxTimeMS = this.options.maxTimeMS;
    }

    super.executeCommand(server, session, cmd, (err, response) => {
      if (err && (err as MongoServerError).code !== 26) {
        callback(err);
        return;
      }

      callback(undefined, response?.cursor?.firstBatch[0]?.n || 0);
    });
  }

  executeLegacy(
    server: Server,
    session: ClientSession | undefined,
    callback: Callback<number>
  ): void {
    const cmd: Document = { count: this.collectionName };

    if (typeof this.options.maxTimeMS === 'number') {
      cmd.maxTimeMS = this.options.maxTimeMS;
    }

    super.executeCommand(server, session, cmd, (err, response) => {
      if (err) {
        callback(err);
        return;
      }

      callback(undefined, response.n || 0);
    });
  }
}

defineAspects(EstimatedDocumentCountOperation, [
  Aspect.READ_OPERATION,
  Aspect.RETRYABLE,
  Aspect.CURSOR_CREATING
]);
