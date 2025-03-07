import type { Db } from '../db.ts';
import { MongoRuntimeError } from '../error.ts';
import type { Server } from '../sdam/server.ts';
import type { ClientSession } from '../sessions.ts';
import type { Callback } from '../utils.ts';
import { CommandOperation, CommandOperationOptions } from './command.ts';

/** @public */
export type ProfilingLevelOptions = CommandOperationOptions;

/** @internal */
export class ProfilingLevelOperation extends CommandOperation<string> {
  override options: ProfilingLevelOptions;

  constructor(db: Db, options: ProfilingLevelOptions) {
    super(db, options);
    this.options = options;
  }

  override execute(
    server: Server,
    session: ClientSession | undefined,
    callback: Callback<string>
  ): void {
    super.executeCommand(server, session, { profile: -1 }, (err, doc) => {
      if (err == null && doc.ok === 1) {
        const was = doc.was;
        if (was === 0) return callback(undefined, 'off');
        if (was === 1) return callback(undefined, 'slow_only');
        if (was === 2) return callback(undefined, 'all');
        // TODO(NODE-3483)
        return callback(new MongoRuntimeError(`Illegal profiling level value ${was}`));
      } else {
        // TODO(NODE-3483): Consider MongoUnexpectedServerResponseError
        err != null ? callback(err) : callback(new MongoRuntimeError('Error with profile command'));
      }
    });
  }
}
