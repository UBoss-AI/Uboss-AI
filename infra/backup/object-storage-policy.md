# Object storage: versioning, lifecycle and replication

Prompt 41 asks for the object-store policy "as required". UBoss stores customer **files** — knowledge
uploads, employee photos, chat attachments — through `StorageAdapter`, and the database holds only a
reference. So a database restore brings back every pointer and **not one byte of content**: the two
have to be recovered together or the recovery is a company with a file list and no files.

This document is the policy to apply to the bucket. It is **not** something the application
configures, and the application cannot see whether it has been applied — `DEPLOYMENT_RESPONSIBILITIES`
says so in the API for the same reason it is said here.

## Versioning: on

**Non-negotiable, and the reason is the deletion path rather than disaster.** UBoss deletes objects
deliberately: the retention sweep, a removed photo, an exit's content deletion. Those are correct
and they are also irreversible. With versioning on, a deletion writes a delete marker and the prior
version survives for the noncurrent window — so a wrongly-run retention sweep is recoverable, and
without versioning it is not.

The interaction with a database restore is the part people miss. Restore the database to yesterday
and it will reference objects that today's sweep deleted. Versioning is what makes those objects
still there.

## Lifecycle

| Rule                               | Setting     | Why                                                                                                                                                                                                |
| ---------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Noncurrent version retention       | **35 days** | Longer than the 30-day exit retention window, so an exit's deletion is still reversible for a few days after the window closes. A shorter window would make the two paths disagree.                |
| Abort incomplete multipart uploads | **7 days**  | A failed 250 MB upload otherwise bills forever and appears in no listing.                                                                                                                          |
| Transition to infrequent access    | **90 days** | Knowledge files are read constantly for a quarter and then almost never.                                                                                                                           |
| Expire noncurrent versions         | **35 days** | The other half of the retention rule: a version kept indefinitely is a copy of deleted customer data with no deletion obligation attached to it, which is the opposite of what Prompt 35 promised. |

**No lifecycle rule may expire a _current_ version.** A current object is referenced by a live row;
expiring it would break a file the product believes it has, and the product would find out when a
customer clicked it. Deletion of current objects belongs to the application, where it is audited.

## Replication

Cross-region, same rules, and **versioning must be on at the destination too** — replicating into an
unversioned bucket copies the objects and loses the property that made them recoverable.

Replicate delete markers: **no**. A wrongly-issued delete should not propagate to the copy that
exists to survive it.

## Legal hold

Prompt 35 put files under legal hold, and the restore path must respect it: a file on hold is not
deleted by the retention sweep, and the bucket's lifecycle rules must not delete it either. Where the
provider supports object-level retention, apply it — otherwise the application's hold is the only
thing standing between a legal hold and a lifecycle rule, and a lifecycle rule does not read the
application's database.

## What a full recovery needs, in order

1. **The encryption keys.** Without them the restored database's credentials and provider keys are
   unreadable, and the company gets its objectives back and none of its integrations.
2. **The database**, restored and verified — `infra/backup/pg-restore-verify.sh`.
3. **The object store**, at a version consistent with the database. If the database is restored to
   an earlier point, objects deleted since must be recovered from their noncurrent versions.

Step 3 is the one that is easy to forget and impossible to fake: the verification checks in this
build prove the _database_ came back, and they say nothing about the bucket. That gap is stated in
the runbook rather than papered over.
