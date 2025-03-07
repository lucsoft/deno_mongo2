import type { Document } from '../bson.ts';
import { Collection } from '../collection.ts';
import { MongoServerError } from '../error.ts';
import type { Server } from '../sdam/server.ts';
import type { ClientSession } from '../sessions.ts';
import { Callback, checkCollectionName } from '../utils.ts';
import type { CommandOperationOptions } from './command.ts';
import { Aspect, defineAspects } from './operation.ts';
import { RunAdminCommandOperation } from './run_command.ts';

/** @public */
export interface RenameOptions extends CommandOperationOptions {
  /** Drop the target name collection if it previously exists. */
  dropTarget?: boolean;
  /** Unclear */
  new_collection?: boolean;
}

/** @internal */
export class RenameOperation extends RunAdminCommandOperation {
  override options: RenameOptions;
  collection: Collection;
  newName: string;

  constructor(collection: Collection, newName: string, options: RenameOptions) {
    // Check the collection name
    checkCollectionName(newName);

    // Build the command
    const renameCollection = collection.namespace;
    const toCollection = collection.s.namespace.withCollection(newName).toString();
    const dropTarget = typeof options.dropTarget === 'boolean' ? options.dropTarget : false;
    const cmd = { renameCollection: renameCollection, to: toCollection, dropTarget: dropTarget };

    super(collection, cmd, options);
    this.options = options;
    this.collection = collection;
    this.newName = newName;
  }

  override execute(
    server: Server,
    session: ClientSession | undefined,
    callback: Callback<Collection>
  ): void {
    const coll = this.collection;

    super.execute(server, session, (err, doc) => {
      if (err) return callback(err);
      // We have an error
      if (doc?.errmsg) {
        return callback(new MongoServerError(doc));
      }

      let newColl: Collection<Document>;
      try {
        newColl = new Collection(coll.s.db, this.newName, coll.s.options);
      } catch (err) {
        return callback(err);
      }

      return callback(undefined, newColl);
    });
  }
}

defineAspects(RenameOperation, [Aspect.WRITE_OPERATION]);
