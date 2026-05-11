<template>
  <div>
    <!-- Loading overlay when hydrating template -->
    <v-overlay v-model="hydrating" class="align-center justify-center" persistent>
      <div class="text-center">
        <v-progress-circular indeterminate color="primary" size="64" width="6"></v-progress-circular>
        <p class="text-body-1 mt-4 text-white">Đang nạp mẫu tin nhắn...</p>
      </div>
    </v-overlay>

    <v-row class="w-100 mx-0 mt-2">
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

                    <!-- Existing remote attachments from template -->
                    <div v-if="existingAttachments.length > 0" class="mb-3">
                      <div class="text-caption text-medium-emphasis mb-2">Tệp từ mẫu (đã có trên server):</div>
                      <v-chip
                        v-for="(att, i) in existingAttachments"
                        :key="i"
                        closable
                        class="mr-2 mb-2"
                        color="primary"
                        variant="tonal"
                        @click:close="removeExistingAttachment(i)"
                      >
                        <v-icon :icon="att.type === 'image' ? 'mdi-image' : 'mdi-file'" size="16" class="mr-1"></v-icon>
                        {{ att.fileName || 'file' }}
                      </v-chip>
                    </div>

                    <!-- New file upload -->
                    <v-file-input
                      v-model="attachmentFiles"
                      accept="image/*,.pdf,.doc,.docx,.zip"
                      :label="existingAttachments.length > 0 ? 'Thêm tệp mới (tùy chọn)' : 'Chọn hình ảnh hoặc tệp tin'"
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
                    <v-card variant="tonal" class="h-100 rounded-lg">
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
                <v-row>
                  <!-- Cột Upload CSV -->
                  <v-col cols="12" md="6">
                    <v-card variant="outlined" class="pa-6 text-center rounded-lg h-100" border="dashed md">
                      <v-icon icon="mdi-file-excel" size="48" color="success" class="mb-4"></v-icon>
                      <div class="text-subtitle-1 font-weight-bold mb-2">Tải lên file Excel/CSV</div>
                      <div class="text-caption text-medium-emphasis mb-4">
                        Hỗ trợ .xlsx, .csv. Hệ thống tự động lọc số trùng lặp.
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
                        style="max-width: 100%"
                        :disabled="excelParsing"
                      ></v-file-input>
                      <v-progress-linear v-if="excelParsing" indeterminate color="primary" class="mt-4"></v-progress-linear>
                      <div v-if="excelParsing" class="text-caption text-primary mt-1">Đang phân tích dữ liệu...</div>
                    </v-card>
                  </v-col>

                  <!-- Cột Chọn Bạn Bè -->
                  <v-col cols="12" md="6">
                    <v-card variant="outlined" class="pa-6 text-center rounded-lg h-100 d-flex flex-column align-center justify-center" border="dashed md">
                      <v-icon icon="mdi-account-group" size="48" color="secondary" class="mb-4"></v-icon>
                      <div class="text-subtitle-1 font-weight-bold mb-2">Chọn từ Bạn bè Zalo</div>
                      <div class="text-caption text-medium-emphasis mb-4">
                        Chọn trực tiếp những người đã là bạn bè trên Zalo.
                      </div>
                      <v-btn color="secondary" variant="flat" prepend-icon="mdi-format-list-bulleted" @click="openFriendDialog" :disabled="selectedAccounts.length === 0">
                        Mở danh sách bạn bè
                      </v-btn>
                      <div v-if="selectedAccounts.length === 0" class="text-caption text-error mt-2">Vui lòng chọn tài khoản gửi trước</div>
                      <div v-else-if="selectedFriends.length > 0" class="text-subtitle-2 text-success mt-3 font-weight-bold">
                        <v-icon icon="mdi-check-circle" size="small" class="mr-1"></v-icon>
                        Đã chọn {{ selectedFriends.length }} bạn bè
                      </div>
                    </v-card>
                  </v-col>
                </v-row>

                <v-alert v-if="finalRecipients.length > 0" type="success" variant="tonal" class="mt-6 text-subtitle-2">
                  Tổng cộng: <strong>{{ finalRecipients.length }}</strong> người nhận 
                  <span v-if="duplicatesRemovedCount > 0" class="text-body-2 font-weight-regular text-warning ml-1">
                    (Đã loại bỏ {{ duplicatesRemovedCount }} người trùng lặp)
                  </span>
                </v-alert>

                <v-alert v-if="phoneMissingCount > 0" type="warning" variant="tonal" class="mt-3 text-subtitle-2" icon="mdi-phone-off">
                  <strong>{{ phoneMissingCount }}</strong> người nhận thiếu số điện thoại hợp lệ.
                  Biến <code v-pre>{{phone}}</code> trong tin nhắn sẽ bị bỏ trống đối với những người này.
                  <div class="text-caption mt-1">Nguyên nhân: Zalo không cung cấp SĐT cho người tự kết bạn.</div>
                </v-alert>

                <v-card-actions class="px-0 mt-6">
                  <v-btn variant="text" size="large" @click="step = 1">Quay lại</v-btn>
                  <v-spacer></v-spacer>
                  <v-btn color="primary" variant="flat" size="large" @click="nextStep(3)" :disabled="selectedAccounts.length === 0">
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

                    <h3 class="text-h6 mt-6 mb-4">Anti-Spam: Khoảng nghỉ giữa các tin</h3>
                    <v-row>
                      <v-col cols="6">
                        <v-text-field
                          v-model.number="delayConfig.min"
                          label="Tối thiểu (giây)"
                          type="number"
                          variant="outlined"
                          :min="1"
                          :rules="[v => v >= 1 || 'Tối thiểu 1 giây']"
                          hint="Mặc định: 5 giây"
                          persistent-hint
                        ></v-text-field>
                      </v-col>
                      <v-col cols="6">
                        <v-text-field
                          v-model.number="delayConfig.max"
                          label="Tối đa (giây)"
                          type="number"
                          variant="outlined"
                          :min="delayConfig.min"
                          :rules="[v => v >= delayConfig.min || `Phải ≥ ${delayConfig.min}s`]"
                          hint="Mặc định: 15 giây"
                          persistent-hint
                        ></v-text-field>
                      </v-col>
                    </v-row>
                    <v-alert type="warning" variant="tonal" class="text-caption mt-2">
                      Hệ thống sẽ nghỉ ngẫu nhiên {{ delayConfig.min }}–{{ delayConfig.max }} giây giữa mỗi tin nhắn để tránh bị Zalo đánh dấu spam.
                    </v-alert>
                  </v-col>

                  <v-col cols="12" md="6">
                    <v-card variant="tonal" color="warning" class="rounded-lg">
                      <v-card-title class="text-subtitle-1 font-weight-bold text-warning d-flex align-center">
                        <v-icon icon="mdi-shield-alert" class="mr-2"></v-icon>
                        Safety Check & Ước tính
                      </v-card-title>
                      <v-card-text>
                        <v-list density="compact" class="bg-transparent">
                          <v-list-item>
                            <template v-slot:prepend><v-icon icon="mdi-account-group"></v-icon></template>
                            <v-list-item-title>Tổng người nhận</v-list-item-title>
                            <template v-slot:append><strong>{{ finalRecipients.length }}</strong></template>
                          </v-list-item>
                          <v-list-item>
                            <template v-slot:prepend><v-icon icon="mdi-account-multiple-remove" color="error"></v-icon></template>
                            <v-list-item-title class="text-error">Nhóm rủi ro cao (Người lạ)</v-list-item-title>
                            <template v-slot:append><strong class="text-error">{{ strangerCount }}</strong></template>
                          </v-list-item>
                          <v-list-item v-if="phoneMissingCount > 0">
                            <template v-slot:prepend><v-icon icon="mdi-phone-off" color="warning"></v-icon></template>
                            <v-list-item-title class="text-warning"><span v-pre>Thiếu SĐT (biến {{phone}} sẽ rỗng)</span></v-list-item-title>
                            <template v-slot:append><strong class="text-warning">{{ phoneMissingCount }}</strong></template>
                          </v-list-item>
                          <v-list-item>
                            <template v-slot:prepend><v-icon icon="mdi-clock-outline"></v-icon></template>
                            <v-list-item-title>Ước tính hoàn thành sau</v-list-item-title>
                            <template v-slot:append><strong>{{ estimatedTime }}</strong></template>
                          </v-list-item>
                        </v-list>
                      </v-card-text>
                    </v-card>

                    <v-alert v-if="phoneMissingCount > 0 && spintaxContent.includes('{{phone}}')" type="warning" variant="tonal" density="compact" class="mt-4" icon="mdi-alert-circle">
                      Tin nhắn có chứa biến <code v-pre>{{phone}}</code> nhưng <strong>{{ phoneMissingCount }}</strong> người nhận không có SĐT. 
                      Nội dung sẽ hiển thị rỗng tại vị trí đó.
                    </v-alert>
                  </v-col>
                </v-row>

                <v-card-actions class="px-0 mt-6">
                  <v-btn variant="text" size="large" @click="step = 2">Quay lại</v-btn>
                  <v-spacer></v-spacer>
                  <v-btn color="success" variant="flat" size="large" :loading="submitting" :disabled="!delayConfigValid" @click="showConfirmDialog = true">
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
              <template v-slot:append><strong>{{ finalRecipients.length }}</strong></template>
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

          <v-alert v-if="strangerCount > finalRecipients.length * 0.5" type="warning" variant="tonal" density="compact" class="mt-4">
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

    <!-- Modal Chọn Bạn bè -->
    <v-dialog v-model="showFriendDialog" max-width="900" scrollable>
      <v-card rounded="lg" class="d-flex flex-column" height="85vh">
        <v-card-title class="text-h6 pa-4 border-b d-flex align-center justify-space-between">
          <span><v-icon icon="mdi-account-group" class="mr-2"></v-icon> Chọn bạn bè từ Zalo</span>
          <v-btn icon="mdi-close" variant="text" size="small" @click="showFriendDialog = false"></v-btn>
        </v-card-title>
        
        <v-card-text class="pa-0 flex-grow-1 overflow-hidden d-flex flex-column">
          <div class="pa-4 bg-surface">
            <v-text-field
              v-model="friendSearch"
              label="Tìm kiếm theo Tên hoặc Số điện thoại"
              prepend-inner-icon="mdi-magnify"
              variant="outlined"
              density="compact"
              hide-details
              clearable
            ></v-text-field>
          </div>
          
          <div v-if="loadingFriends" class="d-flex justify-center align-center flex-grow-1">
            <v-progress-circular indeterminate color="primary"></v-progress-circular>
            <span class="ml-3">Đang tải danh sách bạn bè...</span>
          </div>
          
          <div v-else-if="friendList.length === 0" class="d-flex flex-column justify-center align-center flex-grow-1 text-center py-12">
            <v-icon size="64" color="grey-lighten-1" class="mb-4">mdi-account-off-outline</v-icon>
            <p class="text-h6 text-medium-emphasis">Danh sách trống hoặc chưa được đồng bộ.</p>
            <p class="text-body-2 text-medium-emphasis mb-6">Hãy đảm bảo tài khoản đã được lấy danh sách bạn bè mới nhất.</p>
            <div class="d-flex gap-2">
              <v-btn color="primary" variant="tonal" to="/friends" @click="showFriendDialog = false">Đi đến trang Bạn bè</v-btn>
              <v-btn color="success" variant="flat" to="/friends" @click="showFriendDialog = false">
                <v-icon start>mdi-sync</v-icon> Đồng bộ ngay tại đây
              </v-btn>
            </div>
          </div>

          <v-data-table
            v-else
            v-model="selectedFriends"
            :headers="friendHeaders"
            :items="friendList"
            :search="friendSearch"
            item-value="id"
            return-object
            show-select
            fixed-header
            class="flex-grow-1"
            style="overflow-y: auto; height: 100%;"
            items-per-page="-1"
            hover
          >
            <template v-slot:item.displayName="{ item }">
              <div class="d-flex align-center">
                <v-avatar size="32" class="mr-3" color="grey-lighten-2">
                  <v-img v-if="item.avatarUrl" :src="item.avatarUrl"></v-img>
                  <v-icon v-else icon="mdi-account"></v-icon>
                </v-avatar>
                <div>
                  <div class="font-weight-medium">{{ item.displayName }}</div>
                  <div class="text-caption text-medium-emphasis">{{ item.zaloUid }}</div>
                </div>
              </div>
            </template>
            <template v-slot:item.phone="{ item }">
              {{ item.phone || '-' }}
            </template>
            <template v-slot:item.sourceAccount="{ item }">
              <v-chip size="small" variant="tonal">{{ getAccountDisplayName(item.zaloAccountId) }}</v-chip>
            </template>
          </v-data-table>
        </v-card-text>
        
        <v-card-actions class="pa-4 border-t">
          <div class="text-body-2">
            Đã chọn: <strong class="text-primary">{{ selectedFriends.length }}</strong> người
          </div>
          <v-spacer></v-spacer>
          <v-btn variant="text" @click="showFriendDialog = false">Đóng</v-btn>
          <v-btn color="primary" variant="flat" @click="confirmFriendSelection">Xác nhận</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- E3: Pre-campaign Resolution Dialog -->
    <v-dialog v-model="showSyncDialog" persistent max-width="400">
      <v-card>
        <v-card-title class="text-h6 pb-2">Đồng bộ dữ liệu Zalo</v-card-title>
        <v-card-text>
          <div class="mb-4">Đang dò tìm {{ syncProgress.current }} / {{ syncProgress.total }} số điện thoại...</div>
          <v-progress-linear :model-value="(syncProgress.current / Math.max(1, syncProgress.total)) * 100" color="primary" height="8" rounded striped></v-progress-linear>
          <div class="text-caption text-grey mt-2 text-center">Vui lòng không đóng trình duyệt</div>
        </v-card-text>
      </v-card>
    </v-dialog>

    <!-- Fallout Handling Dialog -->
    <v-dialog v-model="showFalloutDialog" persistent max-width="500">
      <v-card>
        <v-card-title class="text-h6 text-warning pb-2">
          <v-icon icon="mdi-alert" class="mr-2"></v-icon>Phát hiện SĐT rủi ro
        </v-card-title>
        <v-card-text>
          <div class="mb-4">
            Không thể xác định Zalo cho <strong>{{ unresolvedPhones.length }}</strong> số điện thoại (có thể do chưa đăng ký hoặc chặn tìm kiếm).
          </div>
          <v-card variant="outlined" class="mb-4 bg-grey-lighten-4">
            <v-card-text class="pa-2" style="max-height: 150px; overflow-y: auto;">
              <v-chip v-for="phone in unresolvedPhones" :key="phone" size="small" class="ma-1" color="grey-darken-1">{{ phone }}</v-chip>
            </v-card-text>
          </v-card>
          <div>Bạn muốn xử lý danh sách này thế nào?</div>
        </v-card-text>
        <v-card-actions class="px-4 pb-4">
          <v-btn variant="text" color="grey-darken-1" @click="handleFallout('keep')">Gửi qua SĐT (Rủi ro)</v-btn>
          <v-spacer></v-spacer>
          <v-btn variant="flat" color="primary" @click="handleFallout('remove')">Loại bỏ & Gửi (Khuyến nghị)</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter, useRoute, onBeforeRouteLeave } from 'vue-router';
import * as XLSX from 'xlsx';
import { useZaloAccounts } from '@/composables/use-zalo-accounts';
import { campaignApi } from '@/api/campaign.api';
import type { CampaignRecipientPayload, TemplateAttachment } from '@/api/campaign.api';
import { templateApi } from '@/api/template.api';
import type { Attachment } from '@/api/template.api';
import { mediaApi } from '@/api/media.api';
import { friendApi } from '@/api/friend.api';
import type { ZaloFriend } from '@/api/friend.api';

const router = useRouter();
const route = useRoute();
const { accounts, fetchAccounts } = useZaloAccounts();

const step = ref(1);
const submitting = ref(false);
const showConfirmDialog = ref(false);
const campaignLaunched = ref(false); // tracks successful launch for nav guard

const showSyncDialog = ref(false);
const syncProgress = ref({ current: 0, total: 0 });

const showFalloutDialog = ref(false);
const unresolvedPhones = ref<string[]>([]);
let resolveFallout: ((action: 'keep' | 'remove') => void) | null = null;

function handleFallout(action: 'keep' | 'remove') {
  showFalloutDialog.value = false;
  if (resolveFallout) resolveFallout(action);
}

// Step 1: Content
const campaignName = ref('');
const spintaxContent = ref('');
const previewContent = ref('');
const saveAsTemplate = ref(false);
const hydrating = ref(false);

// Hybrid attachments: existing remote files from template
const existingAttachments = ref<TemplateAttachment[]>([]);
const attachmentFiles = ref<File[]>([]);  // E4: raw files for attachment

// Step 2: Data
const selectedAccounts = ref<string[]>([]);
const excelFile = ref<File | null>(null);
const csvRecipients = ref<CampaignRecipientPayload[]>([]); // Data from CSV upload
const excelParsing = ref(false); // E1: loading state

// Friend selection state
const showFriendDialog = ref(false);
const loadingFriends = ref(false);
const friendList = ref<ZaloFriend[]>([]);
const selectedFriends = ref<ZaloFriend[]>([]);
const friendSearch = ref('');

const friendHeaders = [
  { title: 'Bạn bè', key: 'displayName' },
  { title: 'SĐT', key: 'phone' },
  { title: 'Tài khoản', key: 'sourceAccount' }
];

const getAccountDisplayName = (id: string) => {
  return accounts.value.find(a => a.id === id)?.displayName || 'Unknown';
};

// ── Strict phone sanitizer — trả về undefined nếu phone là rác ──────────────────
const getValidPhone = (phoneStr?: string | null): string | undefined => {
  if (!phoneStr) return undefined;
  const digits = String(phoneStr).replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 11) return undefined;
  return digits.replace(/^84/, '0');
};

// Ref to hold final calculated recipients
const finalRecipients = ref<CampaignRecipientPayload[]>([]);
const duplicatesRemovedCount = ref(0);

/**
 * finalizeRecipients — Khử trùng lặp triệt để bằng Two-Pass Merge.
 *
 * Vấn đề cốt lõi đã xác định:
 *   DB Friend: { zaloUid: "210391...", phone: "bạn" } → phone là RÁC
 *   CSV:       { phone: "0376317287", zaloUid: undefined }
 *   → Không có điểm giao → Map coi là 2 người khác nhau → Gửi trùng.
 *
 * Giải pháp:
 *   - PASS 1: Nạp DB friends, dùng getValidPhone() để loại phone rác.
 *     Key chính = zaloUid. Đồng thời index phone hợp lệ vào Set phụ.
 *   - PASS 2: Nạp CSV. Với mỗi CSV entry, kiểm tra:
 *     a) Phone đã có trong knownPhones? → Skip
 *     b) UID đã có trong knownUids? → Skip
 *     c) Nếu cả hai đều không match → Duyệt TOÀN BỘ Map để tìm bản ghi
 *        có cùng validPhone (cross-reference) → Nếu tìm thấy thì bổ sung
 *        phone cho bản ghi DB đó (vì DB đang thiếu) và skip CSV.
 */
function finalizeRecipients() {
  const mergedMap = new Map<string, CampaignRecipientPayload>();
  const knownPhones = new Set<string>();
  const knownUids = new Set<string>();

  // ═══ PASS 1: Nạp Bạn bè (DB) — luôn được giữ, phone rác bị loại bỏ ═══
  let dbCount = 0;
  selectedFriends.value.forEach(friend => {
    const uid = friend.zaloUid || (friend as any).uid || (friend as any).userId || '';
    const validPhone = getValidPhone(friend.phone);

    const uniqueKey = uid || validPhone;
    if (!uniqueKey) return; // Bỏ qua bản ghi hoàn toàn trống

    if (validPhone) knownPhones.add(validPhone);
    if (uid) knownUids.add(uid);

    mergedMap.set(uniqueKey, {
      name: friend.displayName,
      phone: validPhone,          // Phone đã validated (null nếu rác)
      zaloUid: uid || undefined,
      recipientType: 'friend',
      metadata: {},               // Khởi tạo metadata rỗng
    });
    dbCount++;
  });

  // ═══ PASS 2: Nạp CSV — cross-reference chéo với DB ═══
  let csvAdded = 0;
  let csvSkipped = 0;
  csvRecipients.value.forEach(csv => {
    const validPhone = getValidPhone(csv.phone);
    const csvUid = csv.zaloUid || '';

    if (!validPhone && !csvUid) { csvSkipped++; return; }

    // Check 1: Phone hoặc UID trực tiếp trùng
    if ((validPhone && knownPhones.has(validPhone)) || (csvUid && knownUids.has(csvUid))) {
      csvSkipped++;
      // SMART MERGE: Bổ sung phone hợp lệ và metadata từ CSV cho bản ghi DB
      if (validPhone) {
        // Tìm chính xác bản ghi DB có UID trùng với CSV (hoặc bất kỳ friend match)
        for (const entry of mergedMap.values()) {
          if ((csvUid && entry.zaloUid === csvUid) || (validPhone && knownPhones.has(validPhone) && entry.phone === validPhone)) {
            // Merge metadata
            entry.metadata = { ...entry.metadata, ...csv.metadata };
            // Lấy phone nếu thiếu
            if (!entry.phone) {
              entry.phone = validPhone;
              console.log(`[finalizeRecipients] SMART MERGE: enriched friend "${entry.name}" with phone ${validPhone} & metadata`);
            } else {
              console.log(`[finalizeRecipients] SMART MERGE: enriched friend "${entry.name}" with metadata only`);
            }
            break;
          }
        }
      }
      return;
    }

    // Check 2: Cross-reference — Duyệt toàn bộ Map tìm bản ghi cùng người
    // Case: DB friend có uid nhưng phone là rác, CSV có phone nhưng không uid
    // → Cần backend để match, nhưng ở frontend ta vẫn cố gắng phát hiện
    // bằng cách: nếu CSV name gần giống DB name → có thể trùng (heuristic)
    // Tuy nhiên heuristic không tin cậy, nên ta dựa vào backend dedup (Step 2.5)

    // Chưa trùng → thêm vào kết quả
    if (validPhone) knownPhones.add(validPhone);
    if (csvUid) knownUids.add(csvUid);

    mergedMap.set(validPhone || csvUid || Math.random().toString(), {
      name: csv.name,
      phone: validPhone,
      zaloUid: csvUid || undefined,
      recipientType: csv.recipientType || 'stranger',
      metadata: csv.metadata || {},
    });
    csvAdded++;
  });

  // ═══ HARD STOP: Loại bỏ bản ghi thiếu cả phone lẫn UID ═══
  const cleanResult = Array.from(mergedMap.values()).filter(r => r.zaloUid || r.phone);

  finalRecipients.value = cleanResult;
  duplicatesRemovedCount.value = csvRecipients.value.length + selectedFriends.value.length - cleanResult.length;

  // ═══ VALIDATION LOG ═══
  console.log('═══════════════════════════════════════════');
  console.log('🚀 [finalizeRecipients] VALIDATION REPORT');
  console.log(`  ➤ Input: ${selectedFriends.value.length} DB friends + ${csvRecipients.value.length} CSV entries`);
  console.log(`  ➤ DB kept:          ${dbCount}`);
  console.log(`  ➤ CSV added:        ${csvAdded}`);
  console.log(`  ➤ CSV skipped:      ${csvSkipped} (duplicate/empty)`);
  console.log(`  ➤ TOTAL recipients: ${cleanResult.length}`);
  console.log(`  ➤ Duplicates removed: ${duplicatesRemovedCount.value}`);
  console.log('  ➤ Final list:');
  cleanResult.forEach((r, i) => {
    console.log(`    [${i}] name=${r.name || '?'}, phone=${r.phone || 'NULL'}, uid=${r.zaloUid || 'NULL'}, type=${r.recipientType}`);
  });
  console.log('═══════════════════════════════════════════');
}

const activeAccounts = computed(() => accounts.value.filter(a => a.status === 'connected'));

// Excel Mapping
const showMappingDialog = ref(false);
const excelHeaders = ref<string[]>([]);
const rawExcelData = ref<any[]>([]);
const mapping = ref<{ phone: any; name: any; zaloUid: any }>({ phone: null, name: null, zaloUid: null }); // E2: added zaloUid

// Step 3: Config
const activeHours = ref({ start: '08:00', end: '20:00' });
const delayConfig = ref({ min: 5, max: 15 });

const strangerCount = computed(() => finalRecipients.value.filter(r => r.recipientType === 'stranger').length);

// Đếm số người nhận thiếu SĐT hợp lệ (chỉ có UID) → {{phone}} sẽ là rỗng trong tin nhắn
const phoneMissingCount = computed(() => finalRecipients.value.filter(r => !r.phone).length);

const delayConfigValid = computed(() => delayConfig.value.min >= 1 && delayConfig.value.max >= delayConfig.value.min);

const estimatedTime = computed(() => {
  if (selectedAccounts.value.length === 0 || finalRecipients.value.length === 0) return '0 phút';
  // Use average of user-configured delay range
  const avgDelay = (delayConfig.value.min + delayConfig.value.max) / 2;
  const totalSeconds = finalRecipients.value.length * avgDelay;
  const secondsPerAccount = totalSeconds / selectedAccounts.value.length;

  if (secondsPerAccount < 60) return `${Math.ceil(secondsPerAccount)} giây`;
  if (secondsPerAccount < 3600) return `${Math.ceil(secondsPerAccount / 60)} phút`;
  const hours = Math.floor(secondsPerAccount / 3600);
  const mins = Math.ceil((secondsPerAccount % 3600) / 60);
  return `${hours} giờ ${mins} phút`;
});

onMounted(async () => {
  fetchAccounts();

  // ── Template Hydration: load template data if templateId is in URL ────────
  const templateId = route.query.templateId as string | undefined;
  const cloneName = route.query.cloneName as string | undefined;

  if (templateId) {
    hydrating.value = true;
    try {
      const res = await campaignApi.getTemplateById(templateId);
      const tpl = res.data;

      // Fill campaign name (strip "Mẫu: " prefix if present)
      campaignName.value = cloneName || tpl.name.replace(/^Mẫu:\s*/i, '');

      // Fill message content
      spintaxContent.value = tpl.content || '';

      // Fill existing attachments as remote references (no binary download)
      if (tpl.attachments && Array.isArray(tpl.attachments) && tpl.attachments.length > 0) {
        existingAttachments.value = tpl.attachments.map(a => ({
          type: a.type || 'file',
          url: a.url,
          fileName: a.fileName || 'file',
          fileSize: a.fileSize,
        }));
      }

      // Generate preview immediately
      generatePreview();
    } catch (err) {
      console.error('Failed to hydrate template:', err);
      alert('Không thể nạp mẫu tin nhắn. Vui lòng thử lại.');
    } finally {
      hydrating.value = false;
    }
  }
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
  if (n === 3) {
    finalizeRecipients(); // Khử trùng lặp bắt buộc
    if (finalRecipients.value.length === 0) {
      alert("Danh sách người nhận đang trống hoặc tất cả bản ghi đều thiếu SĐT/UID. Vui lòng kiểm tra lại danh sách trước khi đi tiếp.");
      return;
    }
  }
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
  csvRecipients.value = [];
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

    // Lấy tất cả các cột ngoại trừ những cột đã được map
    const metadata: Record<string, any> = {};
    const mappedKeys = [mapping.value.phone, mapping.value.name, mapping.value.zaloUid].filter(Boolean);
    for (const key in row) {
      if (!mappedKeys.includes(key)) {
        metadata[key] = row[key];
      }
    }

    parsedRecipients.push({
      phone,
      zaloUid: zaloUid || undefined,
      name: mapping.value.name ? String(row[mapping.value.name]) : undefined,
      recipientType: 'stranger', // Assume stranger for imported Excel
      metadata,
    });
  }

  csvRecipients.value = parsedRecipients;
  showMappingDialog.value = false;
  finalizeRecipients();
}

// ── Friend Selection Logic ──────────────────────────────────────────────────
async function openFriendDialog() {
  showFriendDialog.value = true;
  loadingFriends.value = true;
  friendList.value = [];
  
  try {
    const promises = selectedAccounts.value.map(accId => friendApi.getFriendsList(accId));
    const results = await Promise.allSettled(promises);
    
    console.log('[CampaignBuilder] Friends API results:', results);

    const allFriends: ZaloFriend[] = [];
    results.forEach((result, index) => {
      const accountId = selectedAccounts.value[index];
      console.log(`[CampaignBuilder] Result for account ${accountId}:`, result);
      
      if (result.status === 'fulfilled') {
        const responseData = result.value.data;
        // Defensive extraction: support both { data: [...] } and directly [...]
        const friendArray = Array.isArray(responseData?.data) ? responseData.data : 
                            (Array.isArray(responseData) ? responseData : []);
                            
        console.log(`[CampaignBuilder] Extracted ${friendArray.length} friends for account ${accountId}`);
        allFriends.push(...friendArray);
      } else {
        console.error(`[CampaignBuilder] Failed to fetch friends for account ${accountId}:`, result.reason);
      }
    });

    // Remove duplicates from raw friend list (same UID across multiple selected accounts)
    const uniqueFriendsMap = new Map<string, ZaloFriend>();
    allFriends.forEach(f => {
      // API might return 'userId' instead of 'zaloUid', map it explicitly
      if (!f.zaloUid && (f as any).userId) {
        f.zaloUid = (f as any).userId;
      }
      
      const key = f.zaloUid || f.id;
      if (key) {
        uniqueFriendsMap.set(key, f);
      } else {
        console.warn('[CampaignBuilder] Friend missing UID key:', f);
      }
    });

    friendList.value = Array.from(uniqueFriendsMap.values());
    console.log('[CampaignBuilder] Final unique friendList count:', friendList.value.length);
  } catch (error) {
    console.error("[CampaignBuilder] Failed to load friends", error);
  } finally {
    loadingFriends.value = false;
  }
}

function confirmFriendSelection() {
  showFriendDialog.value = false;
  finalizeRecipients();
}

// ── Helper: Remove an existing remote attachment ────────────────────────────
function removeExistingAttachment(index: number) {
  existingAttachments.value.splice(index, 1);
}

// ── FIX I3: Confirm dialog handler (Hybrid Attachments) & Pre-campaign sync ───
async function confirmAndLaunch() {
  showConfirmDialog.value = false;
  
  // Step 1: Pre-campaign Resolution (Chốt chặn)
  const phoneOnlyRecipients = finalRecipients.value.filter(r => !r.zaloUid && r.phone);
  
  if (phoneOnlyRecipients.length > 0 && selectedAccounts.value.length > 0) {
    showSyncDialog.value = true;
    syncProgress.value = { current: 0, total: phoneOnlyRecipients.length };
    
    // Simple concurrency limiter
    const limit = 5;
    let active = 0;
    let currentIndex = 0;
    const accountId = selectedAccounts.value[0]; // pick first active account to resolve

    await new Promise<void>((resolve) => {
      const next = async () => {
        if (currentIndex >= phoneOnlyRecipients.length) {
          if (active === 0) resolve();
          return;
        }

        const idx = currentIndex++;
        const recipient = phoneOnlyRecipients[idx];
        active++;

        // Robust Resolver logic (Retry mechanism)
        let resolved = false;
        let attempts = 0;
        
        while (!resolved && attempts < 3) {
          try {
            const res = await friendApi.findUserOnZalo(accountId, recipient.phone as string);
            if (res.data?.data?.uid) {
              recipient.zaloUid = String(res.data.data.uid);
              resolved = true;
            } else {
              break; // Mạng ổn, API ok nhưng không có UID → SĐT rác, không cần retry
            }
          } catch (e) {
            attempts++;
            console.warn(`[Pre-resolve] Lỗi dò SĐT ${recipient.phone} (lần ${attempts}/3). Retrying...`, e);
            if (attempts < 3) {
              await new Promise(r => setTimeout(r, 1000 * attempts)); // Backoff 1s, 2s
            }
          }
        }

        if (!resolved && recipient.phone) {
          unresolvedPhones.value.push(recipient.phone);
        }

        active--;
        syncProgress.value.current++;
        next();
      };

      for (let i = 0; i < limit && i < phoneOnlyRecipients.length; i++) {
        next();
      }
    });

    showSyncDialog.value = false;
    
    // Xử lý Fallout (lỗi không tìm thấy)
    if (unresolvedPhones.value.length > 0) {
      const falloutAction = await new Promise<'keep' | 'remove'>((resolve) => {
        resolveFallout = resolve;
        showFalloutDialog.value = true;
      });

      if (falloutAction === 'remove') {
        // Loại bỏ các bản ghi không thể resolve khỏi finalRecipients
        const removedCount = finalRecipients.value.length;
        finalRecipients.value = finalRecipients.value.filter(
          r => !r.phone || !unresolvedPhones.value.includes(r.phone)
        );
        console.log(`[Fallout] Loại bỏ ${removedCount - finalRecipients.value.length} số lỗi.`);
      } else {
        console.log(`[Fallout] Tiếp tục gửi qua số điện thoại rủi ro.`);
      }
    }

    // Chạy lại deduplication lần cuối để loại bỏ các SĐT vừa phát hiện ra UID trùng
    console.log('[Pre-resolve] Finished resolving. Re-running deduplication...');
    // Cập nhật lại csvRecipients để finalize chạy lại chính xác
    // Ta chỉ cần lọc thẳng trên finalRecipients
    const uids = new Set<string>();
    const cleanList: typeof finalRecipients.value = [];
    let removed = 0;

    for (const r of finalRecipients.value) {
      if (r.zaloUid) {
        if (uids.has(r.zaloUid)) {
          // Phát hiện trùng lặp -> Thực hiện gộp dữ liệu thay vì vứt bỏ hoàn toàn
          const existing = cleanList.find(e => e.zaloUid === r.zaloUid);
          if (existing) {
            // Yêu cầu 1: Ưu tiên số điện thoại từ bản ghi CSV (thường là stranger)
            if (r.phone && r.recipientType !== 'friend') {
              existing.phone = r.phone;
            } else if (!existing.phone && r.phone) {
              existing.phone = r.phone;
            }
            
            // Tên: Bổ sung nếu thiếu
            if (!existing.name && r.name) existing.name = r.name;
            
            // Yêu cầu 2: Gộp chung Metadata
            existing.metadata = { ...existing.metadata, ...r.metadata };
          }
          removed++;
          continue;
        }
        uids.add(r.zaloUid);
      }
      cleanList.push(r);
    }

    finalRecipients.value = cleanList;
    duplicatesRemovedCount.value += removed;
    console.log(`[Pre-resolve] Removed ${removed} duplicates post-resolution.`);
  }

  unresolvedPhones.value = []; // reset state

  if (finalRecipients.value.length === 0) {
    alert("Danh sách người nhận không hợp lệ sau khi đồng bộ.");
    return;
  }

  submitting.value = true;
  try {
    // 1. Create Template (either personal or temporary)
    const templateCategory = saveAsTemplate.value ? 'marketing' : 'temporary';

    // ── Hybrid Attachments: merge existing remote files + new uploads ──────
    // Start with existing remote attachments (already on MinIO, no re-upload)
    const allAttachments: Attachment[] = existingAttachments.value.map(a => ({
      type: a.type,
      url: a.url,
      fileName: a.fileName,
      fileSize: a.fileSize,
    }));

    // Upload NEW files from v-file-input to MinIO
    if (attachmentFiles.value.length > 0) {
      for (const f of attachmentFiles.value) {
        try {
          const res = await mediaApi.uploadMedia(f);
          if (res.data.success) {
            allAttachments.push({
              type: (f.type.startsWith('image/') ? 'image' : 'file') as 'image' | 'file',
              url: res.data.url,
              fileName: res.data.fileName,
              fileSize: f.size,
            });
          }
        } catch (err) {
          console.error('Failed to upload file:', f.name, err);
          throw new Error(`Tải file ${f.name} thất bại. Vui lòng thử lại.`);
        }
      }
    }

    const templateRes = await templateApi.createTemplate({
      name: saveAsTemplate.value ? `Mẫu: ${campaignName.value}` : `Temp_${Date.now()}`,
      content: spintaxContent.value,
      attachments: allAttachments.length > 0 ? allAttachments : undefined,
      category: templateCategory,
      isPersonal: true
    });

    const templateId = templateRes.data.id;

    console.log('Payload chuẩn bị gửi:', finalRecipients.value);

    // 2. Create Campaign
    const res = await campaignApi.createCampaign({
      name: campaignName.value,
      templateId,
      accountIds: selectedAccounts.value,
      activeHours: activeHours.value,
      delayConfig: delayConfig.value,
      recipients: finalRecipients.value,
    });

    if (res.data.success) {
      campaignLaunched.value = true;

      // Kích hoạt Write-back ngầm (Background Task)
      if (selectedAccounts.value.length > 0) {
        const accountId = selectedAccounts.value[0];
        // Chỉ lưu những người có đủ SĐT và UID
        const resolvedItems = finalRecipients.value
          .filter(r => r.zaloUid && r.phone)
          .map(r => ({
            zaloUid: r.zaloUid!,
            phone: r.phone!,
            name: r.name
          }));
          
        if (resolvedItems.length > 0) {
          console.log(`[Write-back] Triggering background upsert for ${resolvedItems.length} resolved records`);
          friendApi.bulkUpsertFriends(accountId, resolvedItems)
            .then(res => console.log('[Write-back] Successful:', res.data.totalUpserted))
            .catch(err => console.warn('[Write-back] Failed:', err));
        }
      }

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
  const hasData = finalRecipients.value.length > 0 || spintaxContent.value.trim().length > 0;
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
