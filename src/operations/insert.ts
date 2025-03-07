import type { Document } from '../bson.ts';
import type { BulkWriteOptions } from '../bulk/common.ts';
import type { Collection } from '../collection.ts';
import { MongoInvalidArgumentError, MongoServerError } from '../error.ts';
import type { InferIdType } from '../mongo_types.ts';
import type { Server } from '../sdam/server.ts';
import type { ClientSession } from '../sessions.ts';
import type { Callback, MongoDBNamespace } from '../utils.ts';
import { WriteConcern } from '../write_concern.ts';
import { BulkWriteOperation } from './bulk_write.ts';
import { CommandOperation, CommandOperationOptions } from './command.ts';
import { prepareDocs } from './common_functions.ts';
import { AbstractOperation, Aspect, defineAspects } from './operation.ts';

/** @internal */
export class InsertOperation extends CommandOperation<Document> {
  override options: BulkWriteOptions;
  documents: Document[];

  constructor(ns: MongoDBNamespace, documents: Document[], options: BulkWriteOptions) {
    super(undefined, options);
    this.options = { ...options, checkKeys: options.checkKeys ?? false };
    this.ns = ns;
    this.documents = documents;
  }

  override execute(
    server: Server,
    session: ClientSession | undefined,
    callback: Callback<Document>
  ): void {
    const options = this.options ?? {};
    const ordered = typeof options.ordered === 'boolean' ? options.ordered : true;
    const command: Document = {
      insert: this.ns.collection,
      documents: this.documents,
      ordered
    };

    if (typeof options.bypassDocumentValidation === 'boolean') {
      command.bypassDocumentValidation = options.bypassDocumentValidation;
    }

    // we check for undefined specifically here to allow falsy values
    // eslint-disable-next-line no-restricted-syntax
    if (options.comment !== undefined) {
      command.comment = options.comment;
    }

    super.executeCommand(server, session, command, callback);
  }
}

/** @public */
export interface InsertOneOptions extends CommandOperationOptions {
  /** Allow driver to bypass schema validation in MongoDB 3.2 or higher. */
  bypassDocumentValidation?: boolean;
  /** Force server to assign _id values instead of driver. */
  forceServerObjectId?: boolean;
}

/** @public */
export interface InsertOneResult<TSchema = Document> {
  /** Indicates whether this write result was acknowledged. If not, then all other members of this result will be undefined */
  acknowledged: boolean;
  /** The identifier that was inserted. If the server generated the identifier, this value will be null as the driver does not have access to that data */
  insertedId: InferIdType<TSchema>;
}

export class InsertOneOperation extends InsertOperation {
  constructor(collection: Collection, doc: Document, options: InsertOneOptions) {
    super(collection.s.namespace, prepareDocs(collection, [doc], options), options);
  }

  override execute(
    server: Server,
    session: ClientSession | undefined,
    callback: Callback<InsertOneResult>
  ): void {
    super.execute(server, session, (err, res) => {
      if (err || res == null) return callback(err);
      if (res.code) return callback(new MongoServerError(res));
      if (res.writeErrors) {
        // This should be a WriteError but we can't change it now because of error hierarchy
        return callback(new MongoServerError(res.writeErrors[0]));
      }

      callback(undefined, {
        acknowledged: this.writeConcern?.w !== 0 ?? true,
        insertedId: this.documents[0]._id
      });
    });
  }
}

/** @public */
export interface InsertManyResult<TSchema = Document> {
  /** Indicates whether this write result was acknowledged. If not, then all other members of this result will be undefined */
  acknowledged: boolean;
  /** The number of inserted documents for this operations */
  insertedCount: number;
  /** Map of the index of the inserted document to the id of the inserted document */
  insertedIds: { [key: number]: InferIdType<TSchema> };
}

/** @internal */
export class InsertManyOperation extends AbstractOperation<InsertManyResult> {
  override options: BulkWriteOptions;
  collection: Collection;
  docs: Document[];

  constructor(collection: Collection, docs: Document[], options: BulkWriteOptions) {
    super(options);

    if (!Array.isArray(docs)) {
      throw new MongoInvalidArgumentError('Argument "docs" must be an array of documents');
    }

    this.options = options;
    this.collection = collection;
    this.docs = docs;
  }

  override execute(
    server: Server,
    session: ClientSession | undefined,
    callback: Callback<InsertManyResult>
  ): void {
    const coll = this.collection;
    const options = { ...this.options, ...this.bsonOptions, readPreference: this.readPreference };
    const writeConcern = WriteConcern.fromOptions(options);
    const bulkWriteOperation = new BulkWriteOperation(
      coll,
      prepareDocs(coll, this.docs, options).map(document => ({ insertOne: { document } })),
      options
    );

    bulkWriteOperation.execute(server, session, (err, res) => {
      if (err || res == null) return callback(err);
      callback(undefined, {
        acknowledged: writeConcern?.w !== 0 ?? true,
        insertedCount: res.insertedCount,
        insertedIds: res.insertedIds
      });
    });
  }
}

defineAspects(InsertOperation, [Aspect.RETRYABLE, Aspect.WRITE_OPERATION]);
defineAspects(InsertOneOperation, [Aspect.RETRYABLE, Aspect.WRITE_OPERATION]);
defineAspects(InsertManyOperation, [Aspect.WRITE_OPERATION]);
