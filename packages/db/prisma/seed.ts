import { PrismaClient } from '@prisma/client';
import { ALL_PERMISSIONS, SYSTEM_ROLES, ROLE_PERMISSIONS, ROLE_DISPLAY_NAMES } from '@openestate/shared';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding permissions...');
  for (const key of ALL_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key },
      update: {},
      create: { key },
    });
  }
  console.log(`  ${ALL_PERMISSIONS.length} permissions seeded.`);

  const allPerms = await prisma.permission.findMany();
  const permByKey = new Map(allPerms.map((p) => [p.key, p.id]));

  const existingCompany = await prisma.company.findFirst();
  if (existingCompany) {
    console.log(`Company already exists (${existingCompany.slug}), skipping company + role seed.`);
    return;
  }

  console.log('Creating demo company...');
  const company = await prisma.company.create({
    data: {
      name: 'Demo Realty Pvt. Ltd.',
      slug: 'demo-realty',
    },
  });

  console.log('Seeding roles...');
  const roleIds: Record<string, string> = {};
  for (const slug of Object.values(SYSTEM_ROLES)) {
    const role = await prisma.role.create({
      data: {
        companyId: company.id,
        name: ROLE_DISPLAY_NAMES[slug],
        slug,
        isSystem: true,
      },
    });
    roleIds[slug] = role.id;

    const perms = ROLE_PERMISSIONS[slug];
    const rolePermData = perms
      .map((key) => {
        const permId = permByKey.get(key);
        if (!permId) return null;
        return { roleId: role.id, permissionId: permId };
      })
      .filter(Boolean) as Array<{ roleId: string; permissionId: string }>;

    if (rolePermData.length > 0) {
      await prisma.rolePermission.createMany({ data: rolePermData });
    }
    console.log(`  ${slug}: ${rolePermData.length} permissions`);
  }

  console.log('Creating admin user...');
  const adminHash = await argon2.hash('Admin@123', { type: argon2.argon2id });
  await prisma.user.create({
    data: {
      companyId: company.id,
      email: 'admin@demo-realty.com',
      name: 'System Admin',
      passwordHash: adminHash,
      roleId: roleIds[SYSTEM_ROLES.SUPER_ADMIN],
      forcePasswordChange: true,
    },
  });

  console.log('Seeding company config...');
  await prisma.companyConfig.create({
    data: {
      companyId: company.id,
      labelOverrides: {
        unit: 'Unit',
        project: 'Project',
        tower: 'Tower',
        floor: 'Floor',
        booking: 'Booking',
        inquiry: 'Inquiry',
      },
      enabledModules: ['presales', 'postsales', 'accounts'],
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      fyStartMonth: 4,
      dateFormat: 'DD-MM-YYYY',
    },
  });

  console.log('Seeding Indian master defaults...');

  const masters = [
    {
      model: 'unitType',
      items: ['1 BHK', '2 BHK', '3 BHK', '4 BHK', 'Studio', 'Penthouse', 'Shop', 'Office'],
    },
    {
      model: 'plcType',
      items: ['Park Facing', 'Corner', 'Road Facing', 'Garden Facing', 'Pool Facing', 'Main Road'],
    },
    {
      model: 'inquirySource',
      items: [
        'Walk-in', 'Phone Call', 'Website', 'MagicBricks', '99acres',
        'Housing.com', 'Referral', 'Broker', 'Social Media', 'Email Campaign',
      ],
    },
    {
      model: 'inquiryType',
      items: ['Fresh', 'Resale', 'Rental', 'Commercial'],
    },
    {
      model: 'inquiryTemperature',
      items: ['Cold', 'Warm', 'Hot'],
    },
    {
      model: 'followUpType',
      items: ['Phone Call', 'Site Visit', 'Email', 'WhatsApp', 'Meeting', 'Video Call'],
    },
    {
      model: 'communicationType',
      items: ['SMS', 'Email', 'WhatsApp', 'Phone Call', 'Letter', 'In-Person'],
    },
    {
      model: 'projectType',
      items: ['Residential', 'Commercial', 'Mixed Use', 'Plotted Development', 'Villa', 'Township'],
    },
    {
      model: 'receiptType',
      items: ['Booking Amount', 'Installment', 'Demand', 'Stamp Duty', 'Registration', 'GST', 'TDS', 'Other'],
    },
    {
      model: 'registrationType',
      items: ['Sale Deed', 'Agreement to Sell', 'Power of Attorney', 'Gift Deed', 'Leave & License'],
    },
    {
      model: 'areaLocation',
      items: ['Noida', 'Greater Noida', 'Gurugram', 'Mumbai', 'Pune', 'Bangalore', 'Hyderabad', 'Chennai'],
    },
    {
      model: 'documentType',
      items: ['PAN Card', 'Aadhaar (reference only)', 'Passport', 'Voter ID', 'Agreement Copy', 'Allotment Letter', 'Demand Letter', 'Receipt', 'NOC', 'Possession Letter'],
      extraFields: { entityType: 'Applicant' },
    },
    {
      model: 'chargeType',
      items: ['Basic Sale Price', 'Floor Rise', 'PLC', 'Club Membership', 'Car Parking', 'Power Backup', 'IFMS', 'Legal Charges', 'Stamp Duty', 'Registration'],
    },
    {
      model: 'bank',
      items: ['State Bank of India', 'HDFC Bank', 'ICICI Bank', 'Axis Bank', 'Punjab National Bank', 'Bank of Baroda', 'Kotak Mahindra Bank', 'Yes Bank'],
    },
    {
      model: 'paymentPlanTemplate',
      items: ['Construction-Linked Plan', 'Down Payment Plan', 'Flexi Plan', 'Subvention Plan'],
    },
  ];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const { model, items, extraFields } of masters as { model: string; items: string[]; extraFields?: Record<string, any> }[]) {
    for (let i = 0; i < items.length; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (prisma as any)[model].create({
        data: {
          companyId: company.id,
          name: items[i],
          sortOrder: i,
          ...extraFields,
        },
      });
    }
    console.log(`  ${model}: ${items.length} entries`);
  }

  console.log('Seeding interest rules...');
  await prisma.interestRule.create({
    data: { companyId: company.id, name: 'Standard 18% p.a.', rateType: 'SIMPLE', ratePercent: 18, frequency: 'YEARLY', sortOrder: 0 },
  });
  await prisma.interestRule.create({
    data: { companyId: company.id, name: 'Penal 24% p.a.', rateType: 'SIMPLE', ratePercent: 24, frequency: 'YEARLY', sortOrder: 1 },
  });

  console.log('Seeding transfer fee rules...');
  await prisma.transferFeeRule.create({
    data: { companyId: company.id, name: 'Standard Transfer Fee', feeType: 'PERCENTAGE', percentage: 2, sortOrder: 0 },
  });
  await prisma.transferFeeRule.create({
    data: { companyId: company.id, name: 'Mutation Charge', feeType: 'FIXED', amountPaise: BigInt(25_000_00), sortOrder: 1 },
  });

  console.log('Seeding GST rates...');
  await prisma.gstRate.create({
    data: {
      companyId: company.id,
      rate: 5,
      description: 'GST 5% (Affordable Housing, HSN 9972)',
      effectiveFrom: new Date('2019-04-01'),
      sortOrder: 0,
    },
  });
  await prisma.gstRate.create({
    data: {
      companyId: company.id,
      rate: 12,
      description: 'GST 12% (Non-Affordable, HSN 9972)',
      effectiveFrom: new Date('2019-04-01'),
      sortOrder: 1,
    },
  });

  console.log('Seeding TDS rules...');
  await prisma.tdsRule.create({
    data: {
      companyId: company.id,
      section: '194-IA',
      ratePercent: 1,
      thresholdPaise: BigInt(50_00_000_00),
      effectiveFrom: new Date('2019-09-01'),
      description: 'TDS on transfer of immovable property',
      sortOrder: 0,
    },
  });

  console.log('Seed complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
