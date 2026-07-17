import { SegmentQueryBuilderService } from './segment-query-builder.service';
import { Segment } from '../../modules/segments/entities/segment.entity';
import { TenantDbContext } from '../../evo-extension-points';

describe('SegmentQueryBuilderService', () => {
  const segmentRepository: any = {};
  const taggingRepository: any = {};
  const db = {
    getRepository: (entity: unknown) =>
      entity === Segment ? segmentRepository : taggingRepository,
  } as unknown as TenantDbContext;
  const contactsClient: any = {};
  const service = new SegmentQueryBuilderService(db, contactsClient);

  it('uses triggerConfig.segment_id as segment strategy', async () => {
    const campaign: any = {
      sendToAll: false,
      triggerConfig: { segment_id: 'seg-trigger-1' },
      steps: null,
      tags: [],
      query: null,
    };

    const result = await service.analyzeSegmentationStrategy(campaign);

    expect(result).toEqual({
      type: 'segment',
      segmentId: 'seg-trigger-1',
    });
  });

  it('extracts segment id recursively from nested steps', async () => {
    const campaign: any = {
      sendToAll: false,
      triggerConfig: null,
      steps: {
        nodes: [
          { id: 'start' },
          {
            id: 'filter',
            config: {
              conditions: [
                { op: 'eq', value: 1 },
                { nested: { segmentId: 'seg-nested-42' } },
              ],
            },
          },
        ],
      },
      tags: [],
      query: null,
    };

    const result = await service.analyzeSegmentationStrategy(campaign);

    expect(result).toEqual({
      type: 'segment',
      segmentId: 'seg-nested-42',
    });
  });

  describe('executeAudienceQuery — tags strategy', () => {
    // Regression: getContactsByTags used to query evo-flow's local
    // `taggings`/`tags` tables directly via TypeORM. That table is
    // unmaintained (TaggingService is explicitly deprecated — "evo-flow no
    // longer persists tagging state locally"; nothing in the identify-event
    // pipeline writes there, only ClickHouse does), so every tag-targeted
    // campaign silently resolved to zero contacts no matter how the
    // audience was configured. CRM is the source of truth for labels and
    // already supports filtering contacts by label name.
    it('resolves tag names via CRM (ContactsClientService.listAllIds), not the local taggings table', async () => {
      contactsClient.listAllIds = jest.fn().mockResolvedValue([
        { id: 'c1', blocked: false },
        { id: 'c2', blocked: false },
      ]);

      const result = await service.executeAudienceQuery(
        {} as any,
        { type: 'tags', tags: ['suporte'] },
      );

      expect(contactsClient.listAllIds).toHaveBeenCalledWith({ labels: ['suporte'] });
      expect(result.contactIds).toEqual(['c1', 'c2']);
      expect(result.total).toBe(2);
    });

    it('filters out blocked contacts', async () => {
      contactsClient.listAllIds = jest.fn().mockResolvedValue([
        { id: 'c1', blocked: false },
        { id: 'c2', blocked: true },
      ]);

      const result = await service.executeAudienceQuery(
        {} as any,
        { type: 'tags', tags: ['suporte'] },
      );

      expect(result.contactIds).toEqual(['c1']);
      expect(result.total).toBe(1);
    });

    it('applies limit/offset over the resolved id list', async () => {
      contactsClient.listAllIds = jest.fn().mockResolvedValue([
        { id: 'c1', blocked: false },
        { id: 'c2', blocked: false },
        { id: 'c3', blocked: false },
      ]);

      const result = await service.executeAudienceQuery(
        {} as any,
        { type: 'tags', tags: ['suporte'] },
        1,
        1,
      );

      expect(result.contactIds).toEqual(['c2']);
      expect(result.total).toBe(3);
    });
  });
});
