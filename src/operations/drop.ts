import type { Db } from '../db.ts';
import type { Server } from '../sdam/server.ts';
import type { ClientSession } from '../sessions.ts';
import type { Callback } from '../utils.ts';
import { CommandOperation, CommandOperationOptions } from './command.ts';
import { Aspect, defineAspects } from './operation.ts';

/** @public */
export type DropCollectionOptions = CommandOperationOptions;

/** @internal */
export class DropCollectionOperation extends CommandOperation<boolean> {
  override options: DropCollectionOptions;
  name: string;

  constructor(db: Db, name: string, options: DropCollectionOptions) {
    super(db, options);
    this.options = options;
    this.name = name;
  }

  override execute(
    server: Server,
    session: ClientSession | undefined,
    callback: Callback<boolean>
  ): void {
    super.executeCommand(server, session, { drop: this.name }, (err, result) => {
      if (err) return callback(err);
      if (result.ok) return callback(undefined, true);
      callback(undefined, false);
    });
  }
}

/** @public */
export type DropDatabaseOptions = CommandOperationOptions;

/** @internal */
export class DropDatabaseOperation extends CommandOperation<boolean> {
  override options: DropDatabaseOptions;

  constructor(db: Db, options: DropDatabaseOptions) {
    super(db, options);
    this.options = options;
  }
  override execute(
    server: Server,
    session: ClientSession | undefined,
    callback: Callback<boolean>
  ): void {
    super.executeCommand(server, session, { dropDatabase: 1 }, (err, result) => {
      if (err) return callback(err);
      if (result.ok) return callback(undefined, true);
      callback(undefined, false);
    });
  }
}

defineAspects(DropCollectionOperation, [Aspect.WRITE_OPERATION]);
defineAspects(DropDatabaseOperation, [Aspect.WRITE_OPERATION]);
