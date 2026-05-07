<template>
  <v-container fluid class="fill-height align-start bg-grey-lighten-4">
    <v-row class="fill-height w-100 mx-0 mt-2">
      <v-col cols="12" md="10" offset-md="1" class="d-flex flex-column">
        <v-card class="elevation-2 rounded-xl mb-6">
          <v-card-title class="text-h5 font-weight-bold pa-6 d-flex align-center">
            <v-icon icon="mdi-bullhorn" color="primary" class="mr-3" size="large"></v-icon>
            Khởi tạo Chiến dịch Gửi tin Hàng loạt
          </v-card-title>
          
          <v-stepper v-model="step" :items="['Nội dung', 'Khách hàng', 'Cấu hình']" hide-actions>
            <template v-slot:item.1>
              <v-card flat class="pa-4">
                <v-row>
                  <v-col cols="12" md="7">
                    <v-text-field
                      v-model="campaignName"
                      label="Tên chiến dịch"
                      variant="outlined"
                      density="comfortable"
                    ></v-text-field>
                    
                    <v-textarea
                      v-model="spintaxContent"
                      label="Nội dung tin nhắn (Hỗ trợ Spintax)"
                      variant="outlined"
                      hint="Ví dụ: {Xin chào|Chào bạn} {{name}}, cảm ơn bạn đã quan tâm."
                      persistent-hint
                      rows="8"
                      class="mt-4"
                    ></v-textarea>
                    
                    <v-checkbox
                      v-model="saveAsTemplate"
                      label="Lưu nội dung này thành mẫu mới"
                      color="primary"
                    ></v-checkbox>

                    <!-- E4: Attachments -->
                    <h4 class="text-subtitle-2 mt-2 mb-2">Tệp đính kèm (Tùy chọn)</h4>
                    <v-file-input
                      v-model="attachmentFiles"
                      accept="image/*,.pdf,.doc,.docx,.zip"
                      label="Chọn hình ảnh hoặc tệp tin"
                      variant="outlined"
                      density="compact"
                      multiple
                      chips
                      prepend-icon=""
                      prepend-inner-icon="mdi-image-plus"
                      hint="Hình ảnh sẽ được cache mediaId sau lần gửi đầu tiên"
                      persistent-hint
                    ></v-file-input>
                  </v-col>
                  
                  <v-col cols="12" md="5">
                    <v-card variant="outlined" class="h-100 rounded-lg bg-blue-grey-lighten-5">
                      <v-card-title class="text-subtitle-1 font-weight-bold d-flex justify-space-between align-center">
                        Xem trước (Preview)
                        <v-btn icon="mdi-refresh" variant="text" size="small" @click="generatePreview" color="primary"></v-btn>
                      </v-card-title>
                      <v-card-text class="text-body-1 whitespace-pre-wrap">
                        {{ previewContent || 'Nhập nội dung để xem trước...' }}
                      </v-card-text>
                    </v-card>
                  </v-col>
                </v-row>
                
                <v-card-actions class="px-0 mt-4">
                  <v-spacer></v-spacer>
                  <v-btn color="primary" variant="flat" size="large" @click="nextStep(2)" :disabled="!campaignName || !spintaxContent">
                    Tiếp tục
                    <v-icon icon="mdi-arrow-right" class="ml-2"></v-icon>
                  </v-btn>
                </v-card-actions>
              </v-card>
            </template>

            <template v-slot:item.2>
              <v-card flat class="pa-4">
                <h3 class="text-h6 mb-4">1. Chọn tài khoản gửi (Pool)</h3>
                <v-select
                  v-model="selectedAccounts"
                  :items="activeAccounts"
                  item-title="displayName"
                  item-value="id"
                  label="Tài khoản Zalo"
                  multiple
                  chips
                  variant="outlined"
                  hint="Hệ thống sẽ tự xoay vòng giữa các tài khoản này"
                  persistent-hint
                ></v-select>

                <h3 class="text-h6 mt-6 mb-4">2. Danh sách Khách hàng</h3>
                <v-card variant="outlined" class="pa-6 text-center rounded-lg" border="dashed md">
                  <v-icon icon="mdi-file-excel" size="64" color="success" class="mb-4"></v-icon>
                  <div class="text-h6 mb-2">Tải lên file Excel/CSV</div>
                  <div class="text-body-2 text-medium-emphasis mb-4">
                    Hỗ trợ file .xlsx, .csv. Hệ thống sẽ tự động lọc số trùng lặp.
                  </div>
                  <v-file-input
                    v-model="excelFile"
                    accept=".xlsx,.csv"
                    label="Chọn file dữ liệu"
                    variant="outlined"
                    density="compact"
                    prepend-icon=""
                    prepend-inner-icon="mdi-paperclip"
                    @update:model-value="handleFileUpload"
                    hide-details
                    class="mx-auto"
                    style="max-width: 400px"
                    :disabled="excelParsing"
                  ></v-file-input>
                  <!-- E1: Loading indicator while parsing -->
                  <v-progress-linear v-if="excelParsing" indeterminate color="primary" class="mt-4"></v-progress-linear>
                  <div v-if="excelParsing" class="text-caption text-primary mt-1">Đang phân tích dữ liệu...</div>
                </v-card>

                <v-alert v-if="recipients.length > 0" type="success" variant="tonal" class="mt-4">
                  Đã tải {{ recipients.length }} khách hàng hợp lệ.
                </v-alert>

                <v-card-actions class="px-0 mt-6">
                  <v-btn variant="text" size="large" @click="step = 1">Quay lại</v-btn>
                  <v-spacer></v-spacer>
                  <v-btn color="primary" variant="flat" size="large" @click="nextStep(3)" :disabled="selectedAccounts.length === 0 || recipients.length === 0">
                    Tiếp tục
                    <v-icon icon="mdi-arrow-right" class="ml-2"></v-icon>
                  </v-btn>
                </v-card-actions>
              </v-card>
            </template>

            <template v-slot:item.3>
              <v-card flat class="pa-4">
                <v-row>
                  <v-col cols="12" md="6">
                    <h3 class="text-h6 mb-4">Cấu hình khung giờ (Active Hours)</h3>
                    <v-row>
                      <v-col cols="6">
                        <v-text-field
                          v-model="activeHours.start"
                          label="Bắt đầu"
                          type="time"
                          variant="outlined"
                        ></v-text-field>
                      </v-col>
                      <v-col cols="6">
                        <v-text-field
                          v-model="activeHours.end"
                          label="Kết thúc"
                          type="time"
                          variant="outlined"
                        ></v-text-field>
                      </v-col>
                    </v-row>
                    <v-alert type="info" variant="tonal" class="text-caption">
                      Tin nhắn sẽ chỉ được gửi trong khung giờ này. Nếu ngoài giờ, hệ thống tự động dời sang ngày mai.
                    </v-alert>
                  </v-col>

                  <v-col cols="12" md="6">
                    <v-card variant="outlined" class="bg-amber-lighten-5 rounded-lg border-warning">
                      <v-card-title class="text-subtitle-1 font-weight-bold text-warning d-flex align-center">
                        <v-icon icon="mdi-shield-alert" class="mr-2"></v-icon>
                        Safety Check & Ước tính
                      </v-card-title>
                      <v-card-text>
                        <v-list density="compact" class="bg-transparent">
                          <v-list-item>
                            <template v-slot:prepend><v-icon icon="mdi-account-group"></v-icon></template>
                            <v-list-item-title>Tổng người nhận</v-list-item-title>
                            <template v-slot:append><strong>{{ recipients.length }}</strong></template>
                          </v-list-item>
                          <v-list-item>
                            <template v-slot:prepend><v-icon icon="mdi-account-multiple-remove" color="error"></v-icon></template>
                            <v-list-item-title class="text-error">Nhóm rủi ro cao (Người lạ)</v-list-item-title>
                            <template v-slot:append><strong class="text-error">{{ strangerCount }}</strong></template>
                          </v-list-item>
                          <v-list-item>
                            <template v-slot:prepend><v-icon icon="mdi-clock-outline"></v-icon></template>
                            <v-list-item-title>Ước tính hoàn thành sau</v-list-item-title>
                            <template v-slot:append><strong>{{ estimatedTime }}</strong></template>
                          </v-list-item>
                        </v-list>
                      </v-card-text>
                    </v-card>
                  </v-col>
                </v-row>

                <v-card-actions class="px-0 mt-6">
                  <v-btn variant="text" size="large" @click="step = 2">Quay lại</v-btn>
                  <v-spacer></v-spacer>
                  <v-btn color="success" variant="flat" size="large" :loading="submitting" @click="showConfirmDialog = true">
                    <v-icon icon="mdi-rocket-launch" class="mr-2"></v-icon>
                    Khởi chạy Chiến dịch
                  </v-btn>
                </v-card-actions>
              </v-card>
            </template>
          </v-stepper>
        </v-card>
      </v-col>
    </v-row>

    <!-- Header Mapping Dialog -->
    <v-dialog v-model="showMappingDialog" max-width="500" persistent>
      <v-card rounded="lg">
        <v-card-title class="text-h6 pa-4 border-b">
          Ánh xạ cột dữ liệu
        </v-card-title>
        <v-card-text class="pa-4">
          <p class="text-body-2 mb-4">Vui lòng chọn cột tương ứng từ file Excel của bạn.</p>
          
          <v-select
            v-model="mapping.phone"
            :items="excelHeaders"
            label="Cột Số điện thoại *"
            variant="outlined"
            density="comfortable"
          ></v-select>
          
          <v-select
            v-model="mapping.name"
            :items="excelHeaders"
            label="Cột Tên khách hàng (Tùy chọn)"
            variant="outlined"
            density="comfortable"
            clearable
          ></v-select>

          <!-- E2: Zalo UID mapping -->
          <v-select
            v-model="mapping.zaloUid"
            :items="excelHeaders"
            label="Cột Zalo UID (Tùy chọn — ưu tiên gửi trực tiếp)"
            variant="outlined"
            density="comfortable"
            clearable
            hint="Nếu có, hệ thống gửi trực tiếp bằng UID không cần lookup số điện thoại"
            persistent-hint
          ></v-select>
        </v-card-text>
        <v-card-actions class="pa-4 border-t">
          <v-spacer></v-spacer>
          <v-btn variant="text" @click="cancelMapping">Hủy</v-btn>
          <v-btn color="primary" variant="flat" @click="applyMapping" :disabled="!mapping.phone">Xác nhận</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- FIX I3: Confirm Launch Dialog -->
    <v-dialog v-model="showConfirmDialog" max-width="520">
      <v-card rounded="lg">
        <v-card-title class="text-h6 pa-4 border-b d-flex align-center">
          <v-icon icon="mdi-shield-check" color="success" class="mr-2"></v-icon>
          Xác nhận Khởi chạy Chiến dịch
        </v-card-title>
        <v-card-text class="pa-4">
          <p class="text-body-1 mb-4">Vui lòng kiểm tra lại các thông số trước khi bắt đầu:</p>
          <v-list density="compact" class="bg-transparent">
            <v-list-item>
              <template v-slot:prepend><v-icon icon="mdi-label" color="primary"></v-icon></template>
              <v-list-item-title>Tên chiến dịch</v-list-item-title>
              <template v-slot:append><strong>{{ campaignName }}</strong></template>
            </v-list-item>
            <v-list-item>
              <template v-slot:prepend><v-icon icon="mdi-account-group"></v-icon></template>
              <v-list-item-title>Tổng người nhận</v-list-item-title>
              <template v-slot:append><strong>{{ recipients.length }}</strong></template>
            </v-list-item>
            <v-list-item v-if="strangerCount > 0">
              <template v-slot:prepend><v-icon icon="mdi-alert" color="error"></v-icon></template>
              <v-list-item-title class="text-error">Người lạ (rủi ro cao)</v-list-item-title>
              <template v-slot:append><strong class="text-error">{{ strangerCount }}</strong></template>
            </v-list-item>
            <v-list-item>
              <template v-slot:prepend><v-icon icon="mdi-account-key"></v-icon></template>
              <v-list-item-title>Tài khoản gửi</v-list-item-title>
              <template v-slot:append><strong>{{ selectedAccounts.length }}</strong></template>
            </v-list-item>
            <v-list-item>
              <template v-slot:prepend><v-icon icon="mdi-clock-outline"></v-icon></template>
              <v-list-item-title>Thời gian dự kiến</v-list-item-title>
              <template v-slot:append><strong>{{ estimatedTime }}</strong></template>
            </v-list-item>
          </v-list>

          <v-alert v-if="strangerCount > recipients.length * 0.5" type="warning" variant="tonal" density="compact" class="mt-4">
            Hơn 50% người nhận là Người lạ. Chiến dịch có nguy cơ bị Zalo hạn chế.
          </v-alert>
        </v-card-text>
        <v-card-actions class="pa-4 border-t">
          <v-spacer></v-spacer>
          <v-btn variant="text" @click="showConfirmDialog = false">Quay lại kiểm tra</v-btn>
          <v-btn color="success" variant="flat" :loading="submitting" @click="confirmAndLaunch">
            <v-icon icon="mdi-rocket-launch" class="mr-1"></v-icon>
            Xác nhận Khởi chạy
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter, onBeforeRouteLeave } from 'vue-router';
import * as XLSX from 'xlsx';
import { useZaloAccounts } from '@/composables/use-zalo-accounts';
import { campaignApi } from '@/api/campaign.api';
import type { CampaignRecipientPayload } from '@/api/campaign.api';
import { templateApi } from '@/api/template.api';
import type { Attachment } from '@/api/template.api';

const router = useRouter();
const { accounts, fetchAccounts } = useZaloAccounts();

const step = ref(1);
const submitting = ref(false);
const showConfirmDialog = ref(false);
const campaignLaunched = ref(false); // tracks successful launch for nav guard

// Step 1: Content
const campaignName = ref('');
const spintaxContent = ref('');
const previewContent = ref('');
const saveAsTemplate = ref(false);
const attachmentFiles = ref<File[]>([]);  // E4: raw files for attachment

// Step 2: Data
const selectedAccounts = ref<string[]>([]);
const excelFile = ref<File | null>(null);
const recipients = ref<CampaignRecipientPayload[]>([]);
const excelParsing = ref(false); // E1: loading state

const activeAccounts = computed(() => accounts.value.filter(a => a.status === 'connected'));

// Excel Mapping
const showMappingDialog = ref(false);
const excelHeaders = ref<string[]>([]);
const rawExcelData = ref<any[]>([]);
const mapping = ref<{ phone: any; name: any; zaloUid: any }>({ phone: null, name: null, zaloUid: null }); // E2: added zaloUid

// Step 3: Config
const activeHours = ref({ start: '08:00', end: '20:00' });

const strangerCount = computed(() => recipients.value.filter(r => r.recipientType === 'stranger').length);

const estimatedTime = computed(() => {
  if (selectedAccounts.value.length === 0 || recipients.value.length === 0) return '0 phút';
  // Stranger = 5 mins (300s), Friend/Thread = 30s
  const totalSeconds = recipients.value.reduce((acc, r) => {
    return acc + (r.recipientType === 'stranger' ? 300 : 30);
  }, 0);
  const secondsPerAccount = totalSeconds / selectedAccounts.value.length;
  
  if (secondsPerAccount < 60) return `${Math.ceil(secondsPerAccount)} giây`;
  if (secondsPerAccount < 3600) return `${Math.ceil(secondsPerAccount / 60)} phút`;
  const hours = Math.floor(secondsPerAccount / 3600);
  const mins = Math.ceil((secondsPerAccount % 3600) / 60);
  return `${hours} giờ ${mins} phút`;
});

onMounted(() => {
  fetchAccounts();
});

// ── FIX C2: Regex đồng bộ với Backend (text-formatter.ts) ──────────────────
// Negative lookbehind (?<!\{) + lookahead (?!\}) → bỏ qua {{var}}
// Yêu cầu ít nhất 1 pipe → chỉ match {A|B}, không match {single}
function parseSpintax(text: string): string {
  const spintaxRegex = /(?<!\{)\{([^{}]+\|[^{}]+)\}(?!\})/g;
  let parsedText = text;
  let safety = 0;
  const MAX_ITERATIONS = 100;

  while (safety++ < MAX_ITERATIONS) {
    const match = spintaxRegex.exec(parsedText);
    if (!match) break;
    const options = match[1].split('|');
    const randomOption = options[Math.floor(Math.random() * options.length)];
    parsedText = parsedText.substring(0, match.index) + randomOption + parsedText.substring(match.index + match[0].length);
    spintaxRegex.lastIndex = 0; // Reset after string mutation
  }
  return parsedText;
}

function generatePreview() {
  // Step 1: Resolve spintax (does NOT touch {{variables}})
  let text = parseSpintax(spintaxContent.value);
  // Step 2: Replace variables with sample data for preview
  text = text.replace(/\{\{\s*name\s*\}\}/gi, 'Nguyễn Văn A');
  text = text.replace(/\{\{\s*phone\s*\}\}/gi, '0987654321');
  text = text.replace(/\{\{\s*email\s*\}\}/gi, 'example@mail.com');
  text = text.replace(/\{\{\s*zaloUid\s*\}\}/gi, '1234567890');
  previewContent.value = text;
}

function nextStep(n: number) {
  if (n === 2) generatePreview();
  step.value = n;
}

// ── E1: Non-blocking Excel parse with loading indicator ────────────────────
function handleFileUpload(file: File | File[] | null) {
  if (!file) return;
  const targetFile = Array.isArray(file) ? file[0] : file;
  if (!targetFile) return;

  excelParsing.value = true; // Show spinner immediately

  const reader = new FileReader();
  reader.onload = (e) => {
    // Yield to browser to render the spinner before heavy sync parse
    setTimeout(() => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];

        const json = XLSX.utils.sheet_to_json(worksheet, { header: 1 }) as any[][];
        if (json.length < 2) {
          alert('File không có dữ liệu');
          excelParsing.value = false;
          return;
        }

        excelHeaders.value = json[0].map(String);
        rawExcelData.value = XLSX.utils.sheet_to_json(worksheet);

        // Auto-guess headers
        mapping.value.phone = excelHeaders.value.find(h => h.toLowerCase().includes('phone') || h.toLowerCase().includes('thoại') || h.toLowerCase().includes('sđt')) as any || null;
        mapping.value.name = excelHeaders.value.find(h => h.toLowerCase().includes('name') || h.toLowerCase().includes('tên')) as any || null;
        // E2: Auto-guess zaloUid column
        mapping.value.zaloUid = excelHeaders.value.find(h => h.toLowerCase().includes('uid') || h.toLowerCase().includes('zalo')) as any || null;

        showMappingDialog.value = true;
      } catch (err) {
        alert('Không thể đọc file. Vui lòng kiểm tra định dạng.');
      } finally {
        excelParsing.value = false;
      }
    }, 50); // 50ms yield for browser to paint the spinner
  };
  reader.readAsArrayBuffer(targetFile);
}

function cancelMapping() {
  showMappingDialog.value = false;
  excelFile.value = null;
  recipients.value = [];
}

function formatPhone(phone: string): string {
  let p = String(phone).replace(/\D/g, '');
  if (p.startsWith('84')) p = '0' + p.slice(2);
  return p;
}

function applyMapping() {
  if (!mapping.value.phone) return;
  
  const parsedRecipients: CampaignRecipientPayload[] = [];
  const phoneSet = new Set<string>();

  for (const row of rawExcelData.value) {
    let rawPhone = row[mapping.value.phone as string];
    if (!rawPhone) continue;
    
    const phone = formatPhone(rawPhone);
    if (!phone || phoneSet.has(phone)) continue;
    
    phoneSet.add(phone);

    // E2: Extract zaloUid if column was mapped
    const zaloUid = mapping.value.zaloUid ? String(row[mapping.value.zaloUid] || '') : undefined;

    parsedRecipients.push({
      phone,
      zaloUid: zaloUid || undefined,
      name: mapping.value.name ? String(row[mapping.value.name]) : undefined,
      recipientType: 'stranger', // Assume stranger for imported Excel
    });
  }

  recipients.value = parsedRecipients;
  showMappingDialog.value = false;
}

// ── FIX I3: Confirm dialog handler ──────────────────────────────────────────
async function confirmAndLaunch() {
  showConfirmDialog.value = false;
  submitting.value = true;
  try {
    // 1. Create Template (either personal or temporary)
    const templateCategory = saveAsTemplate.value ? 'marketing' : 'temporary';

    // E4: Convert raw files to attachment metadata (URL.createObjectURL for preview,
    // but for Backend we send file info — the actual binary upload is handled
    // by Backend's media pipeline when Worker sends the first message)
    const attachments: Attachment[] = attachmentFiles.value.map(f => ({
      type: (f.type.startsWith('image/') ? 'image' : 'file') as 'image' | 'file',
      url: f.name, // Backend will resolve this via multipart or local path
      fileName: f.name,
      fileSize: f.size,
    }));

    const templateRes = await templateApi.createTemplate({
      name: saveAsTemplate.value ? `Mẫu: ${campaignName.value}` : `Temp_${Date.now()}`,
      content: spintaxContent.value,
      attachments: attachments.length > 0 ? attachments : undefined,
      category: templateCategory,
      isPersonal: true
    });

    const templateId = templateRes.data.id;

    // 2. Create Campaign
    const res = await campaignApi.createCampaign({
      name: campaignName.value,
      templateId,
      accountIds: selectedAccounts.value,
      activeHours: activeHours.value,
      recipients: recipients.value,
    });

    if (res.data.success) {
      campaignLaunched.value = true; // Bypass nav guard on redirect
      router.push(`/campaigns/${res.data.campaignId}/monitor`);
    }
  } catch (err: any) {
    alert(err.response?.data?.message || 'Có lỗi xảy ra khi tạo chiến dịch');
  } finally {
    submitting.value = false;
  }
}

// ── FIX I2: Navigation Guard — prevent accidental data loss ─────────────────
onBeforeRouteLeave((_to, _from, next) => {
  // Skip guard if campaign was just launched (redirecting to Monitor)
  if (campaignLaunched.value) return next();

  // Warn if user has entered meaningful data
  const hasData = recipients.value.length > 0 || spintaxContent.value.trim().length > 0;
  if (hasData) {
    const answer = confirm('Bạn có dữ liệu chiến dịch chưa lưu. Chắc chắn muốn rời đi?');
    if (!answer) return next(false);
  }
  next();
});
</script>

<style scoped>
.whitespace-pre-wrap {
  white-space: pre-wrap;
}
</style>
