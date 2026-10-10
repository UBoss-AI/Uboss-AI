import { Module } from '@nestjs/common';

import { BoardRepository } from '../persistence/board.repository.js';
import { OrganizationRepository } from '../persistence/organization.repository.js';
import { BoardController } from './board.controller.js';
import { BoardService } from './board.service.js';

/**
 * Task & Tracker.
 *
 * Nothing is imported here. `PersistenceModule` and `AuthorizationModule` are global, and the
 * audit service comes from the global audit module — so this is the feature and only the
 * feature, which is what makes it possible to say what it depends on by reading one file.
 */
@Module({
  controllers: [BoardController],
  providers: [BoardService, BoardRepository, OrganizationRepository],
  exports: [BoardService],
})
export class BoardsModule {}
