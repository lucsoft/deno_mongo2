import type { Document } from '../../bson.ts';
import { MongoInvalidArgumentError } from '../../error.ts';
import type { ReadPreferenceLike } from '../../read_preference.ts';
import { ReadPreference } from '../../read_preference.ts';
import { ServerType } from '../../sdam/common.ts';
import type { Server } from '../../sdam/server.ts';
import type { ServerDescription } from '../../sdam/server_description.ts';
import type { Topology } from '../../sdam/topology.ts';
import { TopologyDescription } from '../../sdam/topology_description.ts';
import type { OpQueryOptions } from '../commands.ts';
import type { CommandOptions, Connection } from '../connection.ts';

export interface ReadPreferenceOption {
  readPreference?: ReadPreferenceLike;
}

export function getReadPreference(cmd: Document, options?: ReadPreferenceOption): ReadPreference {
  // Default to command version of the readPreference
  let readPreference = cmd.readPreference || ReadPreference.primary;
  // If we have an option readPreference override the command one
  if (options?.readPreference) {
    readPreference = options.readPreference;
  }

  if (typeof readPreference === 'string') {
    readPreference = ReadPreference.fromString(readPreference);
  }

  if (!(readPreference instanceof ReadPreference)) {
    throw new MongoInvalidArgumentError(
      'Option "readPreference" must be a ReadPreference instance'
    );
  }

  return readPreference;
}

export function applyCommonQueryOptions(
  queryOptions: OpQueryOptions,
  options: CommandOptions
): CommandOptions {
  Object.assign(queryOptions, {
    raw: typeof options.raw === 'boolean' ? options.raw : false,
    promoteLongs: typeof options.promoteLongs === 'boolean' ? options.promoteLongs : true,
    promoteValues: typeof options.promoteValues === 'boolean' ? options.promoteValues : true,
    promoteBuffers: typeof options.promoteBuffers === 'boolean' ? options.promoteBuffers : false,
    bsonRegExp: typeof options.bsonRegExp === 'boolean' ? options.bsonRegExp : false,
    enableUtf8Validation:
      typeof options.enableUtf8Validation === 'boolean' ? options.enableUtf8Validation : true
  });

  if (options.session) {
    queryOptions.session = options.session;
  }

  return queryOptions;
}

export function isSharded(topologyOrServer: Topology | Server | Connection): boolean {
  if (topologyOrServer.description && topologyOrServer.description.type === ServerType.Mongos) {
    return true;
  }

  // NOTE: This is incredibly inefficient, and should be removed once command construction
  //       happens based on `Server` not `Topology`.
  if (topologyOrServer.description && topologyOrServer.description instanceof TopologyDescription) {
    const servers: ServerDescription[] = Array.from(topologyOrServer.description.servers.values());
    return servers.some((server: ServerDescription) => server.type === ServerType.Mongos);
  }

  return false;
}
