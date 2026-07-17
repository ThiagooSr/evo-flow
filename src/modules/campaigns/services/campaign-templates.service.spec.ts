import { NotFoundException, BadRequestException } from '@nestjs/common';
import { CampaignTemplatesService } from './campaign-templates.service';
import { Campaign } from '../entities/campaign.entity';
import { CampaignTemplate } from '../entities/campaign-template.entity';

describe('CampaignTemplatesService', () => {
  let service: CampaignTemplatesService;
  let campaignFindOne: jest.Mock;
  let templateFindOne: jest.Mock;
  let templateCreate: jest.Mock;
  let templateSave: jest.Mock;
  let crmGet: jest.Mock;

  beforeEach(() => {
    campaignFindOne = jest.fn().mockResolvedValue({ id: 'camp-1' } as Campaign);
    templateFindOne = jest.fn().mockResolvedValue(null);
    templateCreate = jest.fn((data) => data);
    templateSave = jest.fn((data) => Promise.resolve({ id: 'ct-1', ...data }));
    crmGet = jest.fn();

    const db = {
      getRepository: (entity: unknown) =>
        entity === Campaign
          ? { findOne: campaignFindOne }
          : {
              findOne: templateFindOne,
              create: templateCreate,
              save: templateSave,
            },
    };

    service = new CampaignTemplatesService(db as any, { get: crmGet } as any);
  });

  describe('create', () => {
    // Regression: this used to validate against evo-flow's local
    // `message_templates` table, which has no migration and nothing
    // populates it (message templates are owned by evo-ai-crm-community —
    // Meta/WhatsApp approval lives there). Every template association
    // failed with "relation message_templates does not exist".
    it('validates the template against CRM, not a local table', async () => {
      crmGet.mockResolvedValueOnce({ data: { id: 'tpl-1', active: true } });

      await service.create('camp-1', { messageTemplateId: 'tpl-1' } as any);

      expect(crmGet).toHaveBeenCalledWith('/api/v1/message_templates/tpl-1');
      expect(templateSave).toHaveBeenCalledWith(
        expect.objectContaining({ messageTemplateId: 'tpl-1', variant: 'A' }),
      );
    });

    it('accepts an unwrapped (non-{data}) CRM response', async () => {
      crmGet.mockResolvedValueOnce({ id: 'tpl-1', active: true });

      await expect(
        service.create('camp-1', { messageTemplateId: 'tpl-1' } as any),
      ).resolves.toBeDefined();
    });

    it('throws NotFoundException when the campaign does not exist', async () => {
      campaignFindOne.mockResolvedValueOnce(null);

      await expect(
        service.create('camp-x', { messageTemplateId: 'tpl-1' } as any),
      ).rejects.toThrow(NotFoundException);
      expect(crmGet).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when CRM has no such template (404 -> null)', async () => {
      crmGet.mockResolvedValueOnce(null);

      await expect(
        service.create('camp-1', { messageTemplateId: 'tpl-x' } as any),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when the CRM template is inactive', async () => {
      crmGet.mockResolvedValueOnce({ data: { id: 'tpl-1', active: false } });

      await expect(
        service.create('camp-1', { messageTemplateId: 'tpl-1' } as any),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException on duplicate variant for the same template', async () => {
      crmGet.mockResolvedValueOnce({ data: { id: 'tpl-1', active: true } });
      templateFindOne.mockResolvedValueOnce({ id: 'existing' } as CampaignTemplate);

      await expect(
        service.create('camp-1', { messageTemplateId: 'tpl-1' } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
