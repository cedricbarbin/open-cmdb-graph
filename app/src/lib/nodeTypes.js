// =====================================================================
// CMDB business-screen registry
//
// One entry per node "type" the app exposes as a menu item + list/create/
// edit screen. This is the single source of truth driving the sidebar menu,
// EntityListScreen (table + CSV export), and EntityFormModal (create/edit,
// including relationship pickers with autocomplete) - see README section on
// "Business screens" for the bigger picture.
//
// Field shape:
//   key           property name on the node
//   label         column header / form label
//   required      create-time validation
//   inputType     'text' (default) | 'number' | 'date' | 'datetime' | 'textarea'
//   options       if set, rendered as a <select> instead of a free input
//   readOnlyOnEdit  true for `id` - it's the MERGE key everywhere else
//
// Relationship shape:
//   key           unique within the type, used as React state key
//   label         form label
//   relType       Neo4j relationship type
//   direction     'out' -> (this)-[:REL]->(target)   'in' -> (target)-[:REL]->(this)
//   targetLabels  labels the autocomplete search is restricted to (null = search everything)
//   cardinality   'one' | 'many'
//   required      only enforced for cardinality 'one'
// =====================================================================

const STATUS_ACTIVE = ['active', 'maintenance', 'decommissioned'];
const ENVIRONMENTS = ['prod', 'staging', 'dev'];

export const NODE_TYPES = [
  // ------------------------------------------------------------------
  // Locations
  // ------------------------------------------------------------------
  {
    key: 'datacenter',
    label: 'Datacenter',
    pluralLabel: 'Datacenters',
    category: 'Locations',
    labels: ['Location', 'Datacenter'],
    matchLabel: 'Datacenter',
    idPrefix: 'loc-dc',
    sortField: 'name',
    columns: [
      { key: 'id', label: 'ID' }, { key: 'name', label: 'Name' }, { key: 'provider', label: 'Provider' },
      { key: 'city', label: 'City' }, { key: 'country', label: 'Country' }, { key: 'tier', label: 'Tier' }
    ],
    fields: [
      { key: 'id', label: 'ID', required: true, readOnlyOnEdit: true },
      { key: 'name', label: 'Name', required: true },
      { key: 'provider', label: 'Provider' },
      { key: 'city', label: 'City' },
      { key: 'country', label: 'Country' },
      { key: 'address', label: 'Address' },
      { key: 'tier', label: 'Tier' }
    ],
    relationships: []
  },
  {
    key: 'cloudregion',
    label: 'Cloud Region',
    pluralLabel: 'Cloud Regions',
    category: 'Locations',
    labels: ['Location', 'CloudRegion'],
    matchLabel: 'CloudRegion',
    idPrefix: 'loc-cloud',
    sortField: 'name',
    columns: [
      { key: 'id', label: 'ID' }, { key: 'name', label: 'Name' }, { key: 'provider', label: 'Provider' },
      { key: 'region', label: 'Region' }, { key: 'country', label: 'Country' }
    ],
    fields: [
      { key: 'id', label: 'ID', required: true, readOnlyOnEdit: true },
      { key: 'name', label: 'Name', required: true },
      { key: 'provider', label: 'Provider' },
      { key: 'region', label: 'Region' },
      { key: 'country', label: 'Country' }
    ],
    relationships: []
  },

  // ------------------------------------------------------------------
  // Compute
  // ------------------------------------------------------------------
  {
    key: 'physicalserver',
    label: 'Physical Server',
    pluralLabel: 'Physical Servers',
    category: 'Compute',
    labels: ['Server', 'Physical'],
    matchLabel: 'Physical',
    idPrefix: 'srv-phy',
    sortField: 'hostname',
    columns: [
      { key: 'id', label: 'ID' }, { key: 'hostname', label: 'Hostname' }, { key: 'ipAddress', label: 'IP' },
      { key: 'status', label: 'Status' }, { key: 'environment', label: 'Env' },
      { key: 'vendor', label: 'Vendor' }, { key: 'model', label: 'Model' }
    ],
    fields: [
      { key: 'id', label: 'ID', required: true, readOnlyOnEdit: true },
      { key: 'hostname', label: 'Hostname', required: true },
      { key: 'ipAddress', label: 'IP address' },
      { key: 'os', label: 'OS' },
      { key: 'osVersion', label: 'OS version' },
      { key: 'status', label: 'Status', options: STATUS_ACTIVE },
      { key: 'environment', label: 'Environment', options: ENVIRONMENTS },
      { key: 'cpuCores', label: 'CPU cores', inputType: 'number' },
      { key: 'ramGB', label: 'RAM (GB)', inputType: 'number' },
      { key: 'diskGB', label: 'Disk (GB)', inputType: 'number' },
      { key: 'vendor', label: 'Vendor (display)' },
      { key: 'model', label: 'Model' },
      { key: 'serialNumber', label: 'Serial number' },
      { key: 'rackPosition', label: 'Rack position' },
      { key: 'purchaseDate', label: 'Purchase date', inputType: 'date' },
      { key: 'warrantyEnd', label: 'Warranty end', inputType: 'date' }
    ],
    relationships: [
      { key: 'locatedIn', label: 'Location', relType: 'LOCATED_IN', direction: 'out', targetLabels: ['Location'], cardinality: 'one', required: true },
      { key: 'suppliedBy', label: 'Vendor', relType: 'SUPPLIED_BY', direction: 'out', targetLabels: ['Vendor'], cardinality: 'one' },
      { key: 'coveredBy', label: 'Contract', relType: 'COVERED_BY', direction: 'out', targetLabels: ['Contract'], cardinality: 'one' }
    ]
  },
  {
    key: 'virtualserver',
    label: 'Virtual Server',
    pluralLabel: 'Virtual Servers',
    category: 'Compute',
    labels: ['Server', 'Virtual'],
    matchLabel: 'Virtual',
    idPrefix: 'vm',
    sortField: 'hostname',
    columns: [
      { key: 'id', label: 'ID' }, { key: 'hostname', label: 'Hostname' }, { key: 'ipAddress', label: 'IP' },
      { key: 'status', label: 'Status' }, { key: 'environment', label: 'Env' }, { key: 'hypervisor', label: 'Hypervisor' }
    ],
    fields: [
      { key: 'id', label: 'ID', required: true, readOnlyOnEdit: true },
      { key: 'hostname', label: 'Hostname', required: true },
      { key: 'ipAddress', label: 'IP address' },
      { key: 'os', label: 'OS' },
      { key: 'osVersion', label: 'OS version' },
      { key: 'status', label: 'Status', options: STATUS_ACTIVE },
      { key: 'environment', label: 'Environment', options: ENVIRONMENTS },
      { key: 'cpuCores', label: 'CPU cores', inputType: 'number' },
      { key: 'ramGB', label: 'RAM (GB)', inputType: 'number' },
      { key: 'diskGB', label: 'Disk (GB)', inputType: 'number' },
      { key: 'hypervisor', label: 'Hypervisor' },
      { key: 'vCpu', label: 'vCPU', inputType: 'number' }
    ],
    relationships: [
      { key: 'hostedOn', label: 'Physical host (on-prem)', relType: 'HOSTED_ON', direction: 'out', targetLabels: ['Physical'], cardinality: 'one' },
      { key: 'cloudRegion', label: 'Cloud region (cloud-native)', relType: 'LOCATED_IN', direction: 'out', targetLabels: ['CloudRegion'], cardinality: 'one' }
    ]
  },
  {
    key: 'container',
    label: 'Container',
    pluralLabel: 'Containers',
    category: 'Compute',
    labels: ['Container'],
    matchLabel: 'Container',
    idPrefix: 'ctr',
    sortField: 'name',
    columns: [
      { key: 'id', label: 'ID' }, { key: 'name', label: 'Name' }, { key: 'image', label: 'Image' },
      { key: 'imageTag', label: 'Tag' }, { key: 'status', label: 'Status' }, { key: 'ports', label: 'Ports' }
    ],
    fields: [
      { key: 'id', label: 'ID', required: true, readOnlyOnEdit: true },
      { key: 'name', label: 'Name', required: true },
      { key: 'image', label: 'Image' },
      { key: 'imageTag', label: 'Image tag' },
      { key: 'status', label: 'Status', options: ['running', 'stopped'] },
      { key: 'ports', label: 'Ports' },
      { key: 'cpuLimit', label: 'CPU limit', inputType: 'number' },
      { key: 'memLimitMB', label: 'Memory limit (MB)', inputType: 'number' }
    ],
    relationships: [
      { key: 'runsOn', label: 'Runs on (server)', relType: 'RUNS_ON', direction: 'out', targetLabels: ['Server'], cardinality: 'one', required: true }
    ]
  },

  // ------------------------------------------------------------------
  // Applications & data
  // ------------------------------------------------------------------
  {
    key: 'application',
    label: 'Application',
    pluralLabel: 'Applications',
    category: 'Applications & Data',
    labels: ['Application'],
    matchLabel: 'Application',
    idPrefix: 'app',
    sortField: 'name',
    columns: [
      { key: 'id', label: 'ID' }, { key: 'name', label: 'Name' }, { key: 'version', label: 'Version' },
      { key: 'criticality', label: 'Criticality' }, { key: 'businessService', label: 'Business service' }, { key: 'environment', label: 'Env' }
    ],
    fields: [
      { key: 'id', label: 'ID', required: true, readOnlyOnEdit: true },
      { key: 'name', label: 'Name', required: true },
      { key: 'version', label: 'Version' },
      { key: 'criticality', label: 'Criticality', options: ['low', 'medium', 'high', 'critical'] },
      { key: 'environment', label: 'Environment', options: ENVIRONMENTS },
      { key: 'businessService', label: 'Business service' },
      { key: 'description', label: 'Description', inputType: 'textarea' }
    ],
    relationships: [
      { key: 'dependsOn', label: 'Depends on (applications)', relType: 'DEPENDS_ON', direction: 'out', targetLabels: ['Application'], cardinality: 'many' },
      { key: 'hasSla', label: 'SLA', relType: 'HAS_SLA', direction: 'out', targetLabels: ['SLA'], cardinality: 'one' },
      { key: 'inEnvironment', label: 'Environment (node)', relType: 'IN_ENVIRONMENT', direction: 'out', targetLabels: ['Environment'], cardinality: 'one' }
    ]
  },
  {
    key: 'data',
    label: 'Data Asset',
    pluralLabel: 'Data Assets',
    category: 'Applications & Data',
    labels: ['Data'],
    matchLabel: 'Data',
    idPrefix: 'data',
    sortField: 'name',
    columns: [
      { key: 'id', label: 'ID' }, { key: 'name', label: 'Name' }, { key: 'type', label: 'Type' },
      { key: 'format', label: 'Format' }, { key: 'volumeGB', label: 'Volume (GB)' }, { key: 'environment', label: 'Env' }
    ],
    fields: [
      { key: 'id', label: 'ID', required: true, readOnlyOnEdit: true },
      { key: 'name', label: 'Name', required: true },
      { key: 'description', label: 'Description', inputType: 'textarea' },
      { key: 'type', label: 'Type', options: ['database', 'cache', 'log-store', 'file-store', 'queue'] },
      { key: 'format', label: 'Format' },
      { key: 'volumeGB', label: 'Volume (GB)', inputType: 'number' },
      { key: 'environment', label: 'Environment', options: ENVIRONMENTS }
    ],
    relationships: [
      { key: 'ownedBy', label: 'Owning application', relType: 'OWNS_DATA', direction: 'in', targetLabels: ['Application'], cardinality: 'one', required: true },
      { key: 'classifiedAs', label: 'Data categories', relType: 'CLASSIFIED_AS', direction: 'out', targetLabels: ['DataCategory'], cardinality: 'many' },
      { key: 'storedOn', label: 'Stored on (server)', relType: 'STORED_ON', direction: 'out', targetLabels: ['Server'], cardinality: 'one' }
    ]
  },
  {
    key: 'datacategory',
    label: 'Data Category',
    pluralLabel: 'Data Categories',
    category: 'Applications & Data',
    labels: ['DataCategory'],
    matchLabel: 'DataCategory',
    idPrefix: 'cat',
    sortField: 'name',
    columns: [
      { key: 'id', label: 'ID' }, { key: 'name', label: 'Name' },
      { key: 'sensitivity', label: 'Sensitivity' }, { key: 'regulatoryScope', label: 'Regulatory scope' }
    ],
    fields: [
      { key: 'id', label: 'ID', required: true, readOnlyOnEdit: true },
      { key: 'name', label: 'Name', required: true },
      { key: 'description', label: 'Description', inputType: 'textarea' },
      { key: 'sensitivity', label: 'Sensitivity', options: ['public', 'internal', 'confidential', 'restricted'] },
      { key: 'regulatoryScope', label: 'Regulatory scope', options: ['none', 'GDPR', 'PCI-DSS', 'SOX'] }
    ],
    relationships: []
  },
  {
    key: 'environment',
    label: 'Environment',
    pluralLabel: 'Environments',
    category: 'Applications & Data',
    labels: ['Environment'],
    matchLabel: 'Environment',
    idPrefix: 'env',
    sortField: 'name',
    columns: [{ key: 'id', label: 'ID' }, { key: 'name', label: 'Name' }, { key: 'description', label: 'Description' }],
    fields: [
      { key: 'id', label: 'ID', required: true, readOnlyOnEdit: true },
      { key: 'name', label: 'Name', required: true },
      { key: 'description', label: 'Description', inputType: 'textarea' }
    ],
    relationships: []
  },
  {
    key: 'sla',
    label: 'SLA',
    pluralLabel: 'SLAs',
    category: 'Applications & Data',
    labels: ['SLA'],
    matchLabel: 'SLA',
    idPrefix: 'sla',
    sortField: 'name',
    columns: [
      { key: 'id', label: 'ID' }, { key: 'name', label: 'Name' }, { key: 'uptimeTargetPct', label: 'Uptime target %' },
      { key: 'responseTimeMinutes', label: 'Response (min)' }, { key: 'resolutionTimeHours', label: 'Resolution (h)' }
    ],
    fields: [
      { key: 'id', label: 'ID', required: true, readOnlyOnEdit: true },
      { key: 'name', label: 'Name', required: true },
      { key: 'uptimeTargetPct', label: 'Uptime target %', inputType: 'number' },
      { key: 'responseTimeMinutes', label: 'Response time (min)', inputType: 'number' },
      { key: 'resolutionTimeHours', label: 'Resolution time (h)', inputType: 'number' }
    ],
    relationships: []
  },

  // ------------------------------------------------------------------
  // Network & assets
  // ------------------------------------------------------------------
  {
    key: 'networkinterface',
    label: 'Network Interface',
    pluralLabel: 'Network Interfaces',
    category: 'Network & Assets',
    labels: ['NetworkInterface'],
    matchLabel: 'NetworkInterface',
    idPrefix: 'nic',
    sortField: 'name',
    columns: [
      { key: 'id', label: 'ID' }, { key: 'name', label: 'Name' }, { key: 'type', label: 'Type' },
      { key: 'speedMbps', label: 'Speed (Mbps)' }, { key: 'mac', label: 'MAC' }
    ],
    fields: [
      { key: 'id', label: 'ID', required: true, readOnlyOnEdit: true },
      { key: 'name', label: 'Name', required: true },
      { key: 'type', label: 'Type', options: ['data', 'management'] },
      { key: 'speedMbps', label: 'Speed (Mbps)', inputType: 'number' },
      { key: 'mac', label: 'MAC address' }
    ],
    relationships: [
      { key: 'installedOn', label: 'Installed on (server)', relType: 'HAS_INTERFACE', direction: 'in', targetLabels: ['Server'], cardinality: 'one', required: true }
    ]
  },
  {
    key: 'ipaddress',
    label: 'IP Address',
    pluralLabel: 'IP Addresses',
    category: 'Network & Assets',
    labels: ['IPAddress'],
    matchLabel: 'IPAddress',
    idPrefix: 'ip',
    sortField: 'address',
    columns: [
      { key: 'id', label: 'ID' }, { key: 'address', label: 'Address' }, { key: 'version', label: 'Version' },
      { key: 'type', label: 'Type' }, { key: 'allocation', label: 'Allocation' }
    ],
    fields: [
      { key: 'id', label: 'ID', required: true, readOnlyOnEdit: true },
      { key: 'address', label: 'Address', required: true },
      { key: 'version', label: 'Version', options: ['v4', 'v6'] },
      { key: 'type', label: 'Type', options: ['private', 'public'] },
      { key: 'allocation', label: 'Allocation', options: ['static', 'dhcp'] }
    ],
    relationships: [
      { key: 'onInterface', label: 'Network interface', relType: 'HAS_IP', direction: 'in', targetLabels: ['NetworkInterface'], cardinality: 'one', required: true }
    ]
  },
  {
    key: 'vendor',
    label: 'Vendor',
    pluralLabel: 'Vendors',
    category: 'Network & Assets',
    labels: ['Vendor'],
    matchLabel: 'Vendor',
    idPrefix: 'vnd',
    sortField: 'name',
    columns: [
      { key: 'id', label: 'ID' }, { key: 'name', label: 'Name' }, { key: 'supportPhone', label: 'Support phone' },
      { key: 'supportEmail', label: 'Support email' }, { key: 'website', label: 'Website' }
    ],
    fields: [
      { key: 'id', label: 'ID', required: true, readOnlyOnEdit: true },
      { key: 'name', label: 'Name', required: true },
      { key: 'supportPhone', label: 'Support phone' },
      { key: 'supportEmail', label: 'Support email' },
      { key: 'website', label: 'Website' }
    ],
    relationships: []
  },
  {
    key: 'contract',
    label: 'Contract',
    pluralLabel: 'Contracts',
    category: 'Network & Assets',
    labels: ['Contract'],
    matchLabel: 'Contract',
    idPrefix: 'ctc',
    sortField: 'contractNumber',
    columns: [
      { key: 'id', label: 'ID' }, { key: 'contractNumber', label: 'Contract #' }, { key: 'type', label: 'Type' },
      { key: 'startDate', label: 'Start' }, { key: 'endDate', label: 'End' }, { key: 'cost', label: 'Cost' }, { key: 'currency', label: 'Currency' }
    ],
    fields: [
      { key: 'id', label: 'ID', required: true, readOnlyOnEdit: true },
      { key: 'contractNumber', label: 'Contract number', required: true },
      { key: 'type', label: 'Type', options: ['maintenance', 'support', 'lease'] },
      { key: 'startDate', label: 'Start date', inputType: 'date' },
      { key: 'endDate', label: 'End date', inputType: 'date' },
      { key: 'cost', label: 'Cost', inputType: 'number' },
      { key: 'currency', label: 'Currency' }
    ],
    relationships: [
      { key: 'providedBy', label: 'Vendor', relType: 'PROVIDED_BY', direction: 'out', targetLabels: ['Vendor'], cardinality: 'one', required: true }
    ]
  },

  // ------------------------------------------------------------------
  // Organization
  // ------------------------------------------------------------------
  {
    key: 'team',
    label: 'Team',
    pluralLabel: 'Teams',
    category: 'Organization',
    labels: ['Team'],
    matchLabel: 'Team',
    idPrefix: 'team',
    sortField: 'name',
    columns: [{ key: 'id', label: 'ID' }, { key: 'name', label: 'Name' }, { key: 'email', label: 'Email' }],
    fields: [
      { key: 'id', label: 'ID', required: true, readOnlyOnEdit: true },
      { key: 'name', label: 'Name', required: true },
      { key: 'email', label: 'Email' }
    ],
    relationships: [
      { key: 'owns', label: 'Owns (applications)', relType: 'OWNS', direction: 'out', targetLabels: ['Application'], cardinality: 'many' },
      { key: 'manages', label: 'Manages (servers)', relType: 'MANAGES', direction: 'out', targetLabels: ['Server'], cardinality: 'many' }
    ]
  },
  {
    key: 'person',
    label: 'Person',
    pluralLabel: 'People',
    category: 'Organization',
    labels: ['Person'],
    matchLabel: 'Person',
    idPrefix: 'p',
    sortField: 'name',
    columns: [{ key: 'id', label: 'ID' }, { key: 'name', label: 'Name' }, { key: 'email', label: 'Email' }, { key: 'role', label: 'Role' }],
    fields: [
      { key: 'id', label: 'ID', required: true, readOnlyOnEdit: true },
      { key: 'name', label: 'Name', required: true },
      { key: 'email', label: 'Email', required: true },
      { key: 'role', label: 'Role' }
    ],
    relationships: [
      { key: 'memberOf', label: 'Team', relType: 'MEMBER_OF', direction: 'out', targetLabels: ['Team'], cardinality: 'one', required: true }
    ]
  },

  // ------------------------------------------------------------------
  // ITSM
  // ------------------------------------------------------------------
  {
    key: 'incident',
    label: 'Incident',
    pluralLabel: 'Incidents',
    category: 'ITSM',
    labels: ['Incident'],
    matchLabel: 'Incident',
    idPrefix: 'inc',
    sortField: 'createdAt',
    sortDirection: 'DESC',
    columns: [
      { key: 'id', label: 'ID' }, { key: 'title', label: 'Title' }, { key: 'severity', label: 'Severity' },
      { key: 'status', label: 'Status' }, { key: 'createdAt', label: 'Created' }, { key: 'resolvedAt', label: 'Resolved' }
    ],
    fields: [
      { key: 'id', label: 'ID', required: true, readOnlyOnEdit: true },
      { key: 'title', label: 'Title', required: true },
      { key: 'description', label: 'Description', inputType: 'textarea' },
      { key: 'severity', label: 'Severity', options: ['SEV1', 'SEV2', 'SEV3', 'SEV4'] },
      { key: 'status', label: 'Status', options: ['open', 'investigating', 'resolved', 'closed'] },
      { key: 'createdAt', label: 'Created at', inputType: 'datetime' },
      { key: 'resolvedAt', label: 'Resolved at', inputType: 'datetime' }
    ],
    relationships: [
      { key: 'impacts', label: 'Impacts (resources)', relType: 'IMPACTS', direction: 'out', targetLabels: null, cardinality: 'many' },
      { key: 'reportedBy', label: 'Reported by', relType: 'REPORTED_BY', direction: 'out', targetLabels: ['Person'], cardinality: 'one', required: true }
    ]
  },
  {
    key: 'ticket',
    label: 'Ticket',
    pluralLabel: 'Tickets',
    category: 'ITSM',
    labels: ['Ticket'],
    matchLabel: 'Ticket',
    idPrefix: 'tkt',
    sortField: 'createdAt',
    sortDirection: 'DESC',
    columns: [
      { key: 'id', label: 'ID' }, { key: 'title', label: 'Title' }, { key: 'type', label: 'Type' },
      { key: 'status', label: 'Status' }, { key: 'priority', label: 'Priority' }, { key: 'dueDate', label: 'Due' }
    ],
    fields: [
      { key: 'id', label: 'ID', required: true, readOnlyOnEdit: true },
      { key: 'title', label: 'Title', required: true },
      { key: 'description', label: 'Description', inputType: 'textarea' },
      { key: 'type', label: 'Type', options: ['incident', 'change', 'request'] },
      { key: 'status', label: 'Status', options: ['open', 'in_progress', 'resolved', 'closed'] },
      { key: 'priority', label: 'Priority', options: ['low', 'medium', 'high', 'urgent'] },
      { key: 'createdAt', label: 'Created at', inputType: 'datetime' },
      { key: 'updatedAt', label: 'Updated at', inputType: 'datetime' },
      { key: 'dueDate', label: 'Due date', inputType: 'date' }
    ],
    relationships: [
      { key: 'tracks', label: 'Related incident', relType: 'TRACKS', direction: 'out', targetLabels: ['Incident'], cardinality: 'one' },
      { key: 'concerns', label: 'Concerns (resources)', relType: 'CONCERNS', direction: 'out', targetLabels: null, cardinality: 'many' },
      { key: 'assignedTo', label: 'Assigned to', relType: 'ASSIGNED_TO', direction: 'out', targetLabels: ['Person'], cardinality: 'one', required: true },
      { key: 'openedBy', label: 'Opened by', relType: 'OPENED_BY', direction: 'out', targetLabels: ['Person'], cardinality: 'one', required: true }
    ]
  },
  {
    key: 'changerequest',
    label: 'Change Request',
    pluralLabel: 'Change Requests',
    category: 'ITSM',
    labels: ['ChangeRequest'],
    matchLabel: 'ChangeRequest',
    idPrefix: 'chg',
    sortField: 'title',
    columns: [
      { key: 'id', label: 'ID' }, { key: 'title', label: 'Title' }, { key: 'status', label: 'Status' },
      { key: 'riskLevel', label: 'Risk' }, { key: 'scheduledStart', label: 'Scheduled start' }, { key: 'scheduledEnd', label: 'Scheduled end' }
    ],
    fields: [
      { key: 'id', label: 'ID', required: true, readOnlyOnEdit: true },
      { key: 'title', label: 'Title', required: true },
      { key: 'description', label: 'Description', inputType: 'textarea' },
      { key: 'status', label: 'Status', options: ['draft', 'approved', 'scheduled', 'implemented', 'failed', 'rolled_back'] },
      { key: 'riskLevel', label: 'Risk level', options: ['low', 'medium', 'high'] },
      { key: 'scheduledStart', label: 'Scheduled start', inputType: 'datetime' },
      { key: 'scheduledEnd', label: 'Scheduled end', inputType: 'datetime' },
      { key: 'implementedAt', label: 'Implemented at', inputType: 'datetime' }
    ],
    relationships: [
      { key: 'concerns', label: 'Concerns (resources)', relType: 'CONCERNS', direction: 'out', targetLabels: null, cardinality: 'many' },
      { key: 'requestedBy', label: 'Requested by', relType: 'REQUESTED_BY', direction: 'out', targetLabels: ['Person'], cardinality: 'one', required: true },
      { key: 'assignedTo', label: 'Assigned to', relType: 'ASSIGNED_TO', direction: 'out', targetLabels: ['Person'], cardinality: 'one', required: true },
      { key: 'approvedBy', label: 'Approved by', relType: 'APPROVED_BY', direction: 'out', targetLabels: ['Person'], cardinality: 'one' }
    ]
  }
];

export const NODE_TYPE_CATEGORIES = Array.from(new Set(NODE_TYPES.map((t) => t.category)));

export function getNodeType(key) {
  return NODE_TYPES.find((t) => t.key === key) || null;
}
