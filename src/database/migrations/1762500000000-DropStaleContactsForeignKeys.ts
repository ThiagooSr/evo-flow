import { MigrationInterface, QueryRunner, TableForeignKey } from 'typeorm';

/**
 * Drops the 3 foreign keys still pointing at evo-flow's local `contacts`
 * table (campaigns_contacts, journey_sessions, short_links). That table is
 * a leftover from before the "CRM owns contact data" cleanup —
 * SegmentQueryBuilderService's own comment already documents "this service
 * no longer reads from the local `contacts` table" — and nothing populates
 * it anymore (0 rows in production). Contact ids flowing through the app
 * are now CRM ids fetched via ContactsClientService, so any insert
 * referencing a real contact violated these constraints unconditionally:
 * campaign audience population failed 100% of the time with "insert or
 * update on table campaigns_contacts violates foreign key constraint".
 *
 * The `contacts` table itself is left in place (dead schema, harmless) —
 * only the constraints tying live inserts to it are removed.
 */
export class DropStaleContactsForeignKeys1762500000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropForeignKey(
      'campaigns_contacts',
      'FK_cd19cb51941f06dec13facdcdbc',
    );
    await queryRunner.dropForeignKey(
      'journey_sessions',
      'FK_journey_sessions_contact_id',
    );

    const shortLinksHasFk = (
      await queryRunner.getTable('short_links')
    )?.foreignKeys.some((fk) => fk.name === 'FK_short_links_contact');
    if (shortLinksHasFk) {
      await queryRunner.dropForeignKey(
        'short_links',
        'FK_short_links_contact',
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createForeignKey(
      'campaigns_contacts',
      new TableForeignKey({
        name: 'FK_cd19cb51941f06dec13facdcdbc',
        columnNames: ['contact_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'contacts',
        onDelete: 'CASCADE',
      }),
    );
    await queryRunner.createForeignKey(
      'journey_sessions',
      new TableForeignKey({
        name: 'FK_journey_sessions_contact_id',
        columnNames: ['contact_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'contacts',
        onDelete: 'CASCADE',
      }),
    );
    await queryRunner.createForeignKey(
      'short_links',
      new TableForeignKey({
        name: 'FK_short_links_contact',
        columnNames: ['contact_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'contacts',
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      }),
    );
  }
}
