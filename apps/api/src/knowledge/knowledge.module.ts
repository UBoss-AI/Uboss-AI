import { Global, Module } from '@nestjs/common';

import { FileController } from './file.controller.js';
import { FileService } from './file.service.js';
import { KnowledgeController } from './knowledge.controller.js';
import { KnowledgeService } from './knowledge.service.js';
import { MALWARE_SCANNER, MockMalwareScanner } from './malware-scanner.js';
import { InMemoryStorageAdapter, STORAGE_ADAPTER } from './storage-adapter.js';

/**
 * Knowledge, files and safe uploads — Prompt 35.
 *
 * `@Global` because an Engine Agent run has to ask "may I consult this source" and the Executor
 * Agent has to be able to see that a file it was about to send is `Restricted`. One service
 * answering both means one place where §22's rules are applied.
 *
 * ## Which adapters are bound, and the rule for changing that
 *
 * `InMemoryStorageAdapter` and `MockMalwareScanner` — both real, both honest about what they are.
 * The in-memory store works and does not survive a restart; the mock scanner detects the EICAR
 * test file and records `scannedByRealScanner: false` on every verdict it writes. `S3StorageAdapter`
 * exists in the same file and is deliberately **not** bound: it has no bucket, endpoint or
 * credential, so binding it would mean every upload failed. It is the seam, not the integration.
 *
 * Swapping either is one line here, which is the entire point of the two tokens. What must not
 * happen is a scanner that returns `scannedByRealScanner: true` without a real antivirus product
 * behind it — that flag travels onto the file row and into any compliance answer the company gives.
 */
@Global()
@Module({
  controllers: [FileController, KnowledgeController],
  providers: [
    FileService,
    KnowledgeService,
    { provide: STORAGE_ADAPTER, useClass: InMemoryStorageAdapter },
    { provide: MALWARE_SCANNER, useClass: MockMalwareScanner },
  ],
  exports: [FileService, KnowledgeService, STORAGE_ADAPTER, MALWARE_SCANNER],
})
export class KnowledgeModule {}
