import { Global, Module } from '@nestjs/common';

import { FileController } from './file.controller.js';
import { FileService } from './file.service.js';
import { KnowledgeController } from './knowledge.controller.js';
import { KnowledgeService } from './knowledge.service.js';
import { MALWARE_SCANNER, MockMalwareScanner } from './malware-scanner.js';
import {
  DiskStorageAdapter,
  InMemoryStorageAdapter,
  STORAGE_ADAPTER,
  StorageAdapter,
} from './storage-adapter.js';

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
    /*
     * Disk when a directory is configured, memory otherwise.
     *
     * The in-memory adapter was what every deployment got, including a real one — so every
     * uploaded file would have lived in the API process and vanished on the next restart. The
     * record would survive and the bytes would not, which shows up as a download that fails long
     * after the upload was forgotten.
     *
     * An environment variable rather than `NODE_ENV`, because "is there somewhere durable to put
     * files" is a fact about the deployment and not about the mode it thinks it is in. Absent
     * means memory, which is right for tests and for a development run with no volume.
     */
    {
      provide: STORAGE_ADAPTER,
      useFactory: (): StorageAdapter => {
        const directory = process.env['UBOSS_FILE_STORAGE_DIR']?.trim();
        return directory === undefined || directory === ''
          ? new InMemoryStorageAdapter()
          : new DiskStorageAdapter(directory);
      },
    },
    { provide: MALWARE_SCANNER, useClass: MockMalwareScanner },
  ],
  exports: [FileService, KnowledgeService, STORAGE_ADAPTER, MALWARE_SCANNER],
})
export class KnowledgeModule {}
