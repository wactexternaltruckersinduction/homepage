// ==========================================
// 1. SUPABASE INITIALIZATION
// ==========================================
const SUPABASE_URL = 'https://vokpqpwwdpclxnqkhsry.supabase.co'; 
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZva3BxcHd3ZHBjbHhucWtoc3J5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4NDMxMTAsImV4cCI6MjA5NzQxOTExMH0.ZEPAUHGuWoKOUSPyPcMpAlydRgDQ0bf3-p6yKZvg8_8';

window.supabaseClient = null;
if (typeof supabase !== 'undefined') {
    window.supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

// Helper to guarantee connection
function getDb() {
    if (!window.supabaseClient) window.supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return window.supabaseClient;
}

// ==========================================
// 2. SYSTEM SETTINGS MANAGER
// ==========================================
async function getSystemSettings() {
    const { data, error } = await getDb().from('system_settings').select('*');
    if (error) return { capacity: 10, blockedDates: [], blockedTimes: [], customCapacities: {} };

    let settings = { capacity: 10, blockedDates: [], blockedTimes: [], customCapacities: {} };
    
    data.forEach(row => {
        if (row.setting_key === 'global_capacity') settings.capacity = parseInt(row.setting_value) || 10;
        if (row.setting_key === 'blocked_dates' && row.setting_value) settings.blockedDates = row.setting_value.split(',').map(d => d.trim());
        if (row.setting_key === 'blocked_times' && row.setting_value) settings.blockedTimes = row.setting_value.split(',').map(d => d.trim());
        if (row.setting_key === 'custom_capacities' && row.setting_value) {
            row.setting_value.split(',').forEach(pair => {
                let parts = pair.split(':');
                if (parts.length === 2) settings.customCapacities[parts[0].trim()] = parseInt(parts[1].trim());
            });
        }
    });
    return settings;
}

async function safeUpsertSetting(key, val) {
    const { data } = await getDb().from('system_settings').select('*').eq('setting_key', key);
    if (data && data.length > 0) { await getDb().from('system_settings').update({ setting_value: val }).eq('setting_key', key); } 
    else { await getDb().from('system_settings').insert([{ setting_key: key, setting_value: val }]); }
}

async function removeSystemSetting(type, target, adminUid) {
    try {
        const settings = await getSystemSettings();
        if (type === 'block_time') {
            const newArr = settings.blockedTimes.filter(t => t !== target);
            await safeUpsertSetting('blocked_times', newArr.join(','));
        } else if (type === 'block_date') {
            const newArr = settings.blockedDates.filter(d => d !== target);
            await safeUpsertSetting('blocked_dates', newArr.join(','));
        } else if (type === 'custom_cap') {
            delete settings.customCapacities[target];
            let arr = [];
            for (const [k, v] of Object.entries(settings.customCapacities)) { arr.push(`${k}:${v}`); }
            await safeUpsertSetting('custom_capacities', arr.join(','));
        }
        await logAuditAction(adminUid, 'SETTINGS_REMOVED', target, `Removed ${type}`);
        return { result: 'success' };
    } catch (e) {
        return { result: 'error', message: e.message };
    }
}

// ==========================================
// 3. STORAGE HELPER
// ==========================================
async function uploadToStorage(fileObj, inductionId, driverName, documentType) {
    if (!fileObj || !fileObj.base64) return null;
    try {
        const byteCharacters = atob(fileObj.base64);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) byteNumbers[i] = byteCharacters.charCodeAt(i);
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: fileObj.type });
        const safeId = String(inductionId).replace(/\//g, '-');
        const safeName = String(driverName).replace(/[^a-zA-Z0-9]/g, '_');
        const fileName = `${safeName}_${documentType}_${safeId}`;
        const { data, error } = await getDb().storage.from('driver-documents').upload(fileName, blob, { upsert: true, contentType: fileObj.type });
        if (error) throw error;
        const { data: publicUrlData } = getDb().storage.from('driver-documents').getPublicUrl(data.path);
        return publicUrlData.publicUrl + "?t=" + Date.now(); 
    } catch (err) { return null; }
}

// ==========================================
// 4. DRIVER LOGIN ENGINE
// ==========================================
async function driverLogin(inductionNumber, password) {
    try {
        const inputId = String(inductionNumber).trim();
        const inputPass = String(password).trim().toLowerCase();

        const [idSearch, licSearch] = await Promise.all([
            getDb().from('drivers').select('*').ilike('induction_number', `%${inputId}%`),
            getDb().from('drivers').select('*').ilike('license_number', `%${inputId}%`)
        ]);

        if (idSearch.error) throw idSearch.error;
        if (licSearch.error) throw licSearch.error;

        let allMatches = [];
        if (idSearch.data) allMatches.push(...idSearch.data);
        if (licSearch.data) allMatches.push(...licSearch.data);

        if (allMatches.length === 0) return { result: 'error', message: 'User ID or License not found.' };

        let validDriver = null;
        for (let d of allMatches) {
            const licenseLast5 = String(d.license_number).trim().toLowerCase().slice(-5);
            if (licenseLast5 === inputPass) { validDriver = d; break; }
        }

        if (!validDriver) return { result: 'error', message: 'Incorrect License Password.' };

        const { data: appts } = await getDb().from('appointments').select('*').eq('induction_number', validDriver.induction_number).order('created_at', { ascending: false }).limit(1);
        const appt = (appts && appts.length > 0) ? appts[0] : null;

        let isSuspended = false;
        let suspensionEnd = null;
        let activeBanReason = "";

        if (appt && appt.medic_status && appt.medic_status.startsWith('Failed')) {
            activeBanReason = appt.medic_status.replace('Failed: ', '');
            const failDate = new Date(appt.appointment_date);
            let banEndDate = new Date(failDate);

            const match = activeBanReason.match(/\((\d+)\s+(week|month|year)s?\s+ban\)/i);
            const isPerm = activeBanReason.toLowerCase().includes('permanent');

            if (isPerm) {
                isSuspended = true; banEndDate.setFullYear(banEndDate.getFullYear() + 99); 
            } else if (match) {
                const amount = parseInt(match[1]); const unit = match[2].toLowerCase();
                if (unit === 'week') banEndDate.setDate(banEndDate.getDate() + (amount * 7));
                if (unit === 'month') banEndDate.setMonth(banEndDate.getMonth() + amount);
                if (unit === 'year') banEndDate.setFullYear(banEndDate.getFullYear() + amount);

                if (new Date() < banEndDate) {
                    isSuspended = true; suspensionEnd = banEndDate.toISOString().split('T')[0];
                } else {
                    await getDb().from('appointments').update({ medic_status: 'Pending', hse_status: 'Pending', appointment_status: 'Booked', reschedule_count: 0 }).eq('induction_number', validDriver.induction_number);
                    activeBanReason = ""; appt.appointment_status = "Booked";
                }
            }
        }

        const formattedProfile = {
            fullName: validDriver.full_name, inductionNumber: validDriver.induction_number, licenseNumber: validDriver.license_number, dob: validDriver.dob, passportPhoto: validDriver.passport_photo, mobileNumber: validDriver.mobile_number, companyName: validDriver.company_name, address: validDriver.address, inductionExpiration: validDriver.induction_expiration, licenseExpiration: validDriver.license_expiration, docLicense: validDriver.drivers_license, docOther: validDriver.other_documents || validDriver.recommendation_letter 
        };
        const managementData = {
            status: appt ? appt.appointment_status : "Booked", daReason: activeBanReason, currentAppointment: appt ? appt.appointment_date : "", appointmentTime: appt ? appt.appointment_time : "", appointmentId: appt ? appt.appointment_id : "", hseDate: appt ? appt.hse_date : "", rescheduleCount: appt ? appt.reschedule_count : 0, isSuspended: isSuspended, suspensionEnd: suspensionEnd
        };
        return { result: 'success', profile: formattedProfile, apptData: managementData };
    } catch (err) { return { result: 'error', message: 'Database connection failed.' }; }
}

// ==========================================
// 5. NEW & RENEWAL SUBMISSIONS
// ==========================================
async function submitNew(payload) {
    try {
        const expDate = new Date(payload.licenseExpDate); const minValidDate = new Date(); minValidDate.setMonth(minValidDate.getMonth() + 3);
        if (expDate < minValidDate) return { result: 'error', message: "Application Rejected: Driver's license must be valid for at least 3 months." };

        const cleanLicense = String(payload.licenseDetails).trim();
        const { data: existingDriver, error: licErr } = await getDb().from('drivers').select('full_name, induction_number').ilike('license_number', cleanLicense).limit(1);
        if (licErr) throw licErr;
        if (existingDriver && existingDriver.length > 0) return { result: 'error', message: `Driver already exists! Please login using the Renewal Portal.` };

        const currentYear = new Date().getFullYear();
        const { data: recentDrivers, error: numErr } = await getDb()
            .from('drivers')
            .select('induction_number')
            .ilike('induction_number', `%/${currentYear}/%`)
            .order('created_at', { ascending: false })
            .limit(50);
            
        if (numErr) throw numErr;

        let highestNum = 1000; 
        if (recentDrivers && recentDrivers.length > 0) {
            for (let d of recentDrivers) {
                if (d.induction_number) {
                    const parts = d.induction_number.split('/'); 
                    const lastDigit = parseInt(parts[parts.length - 1]);
                    if (!isNaN(lastDigit) && lastDigit > highestNum) highestNum = lastDigit;
                }
            }
        }
        
        const nextNum = highestNum + 1; 
        const newID = `SI/EXT/${currentYear}/${nextNum.toString().padStart(4, '0')}`;

        const [passportUrl, licenseUrl, otherUrl] = await Promise.all([
            uploadToStorage(payload.passportPhoto, newID, payload.fullName, "Passport"),
            uploadToStorage(payload.driversLicense, newID, payload.fullName, "License"),
            uploadToStorage(payload.otherDocuments || payload.recLetter, newID, payload.fullName, "OtherDoc")
        ]);

        const { error } = await getDb().from('drivers').insert([{
           induction_number: newID, 
            full_name: payload.fullName, 
            address: payload.address, 
            state: payload.state, 
            lga: payload.lga, 
            religion: payload.religion, 
            mobile_number: payload.mobile, 
            dob: payload.dob, 
            marital_status: payload.maritalStatus, 
            license_number: cleanLicense, 
            license_expiration: payload.licenseExpDate, 
            company_name: payload.companyName, 
            ref1_name: payload.ref1Name, 
            ref1_address: payload.ref1Address, 
            ref1_position: payload.ref1Position, 
            ref1_duration: payload.ref1Duration, 
            ref1_contact: payload.ref1Contact, 
            ref2_name: payload.ref2Name, 
            ref2_address: payload.ref2Address,     
            ref2_position: payload.ref2Position,   
            ref2_duration: payload.ref2Duration,   
            ref2_contact: payload.ref2Contact,     
            passport_photo: passportUrl, 
            drivers_license: licenseUrl, 
            other_documents: otherUrl, 
            recommendation_letter: otherUrl,       
            induction_status: 'Pending'
        }]);

        if (error) throw error;
        return { result: 'success', inductionNumber: newID };
    } catch (err) { return { result: 'error', message: err.message }; }
}

async function submitRenewal(payload) {
    try {
        const expDate = new Date(payload.licenseExpiration); const minValidDate = new Date(); minValidDate.setMonth(minValidDate.getMonth() + 3);
        if (expDate < minValidDate) return { result: 'error', message: "Application Rejected: License must be valid for at least 3 months." };

        // 👉 SPEED FIX: Fire all file uploads to Supabase at the exact same time
        const uploadTasks = [];
        if (payload.passportPhoto) uploadTasks.push(uploadToStorage(payload.passportPhoto, payload.inductionNumber, payload.fullName, "Passport").then(url => ({key: 'passport_photo', url})));
        if (payload.driversLicense) uploadTasks.push(uploadToStorage(payload.driversLicense, payload.inductionNumber, payload.fullName, "License").then(url => ({key: 'drivers_license', url})));
        if (payload.otherDocuments) uploadTasks.push(uploadToStorage(payload.otherDocuments, payload.inductionNumber, payload.fullName, "OtherDoc").then(url => ({key: 'other_documents', url})));
        
        // CATCHING THE POLICE REPORT
        if (payload.policeReport) uploadTasks.push(uploadToStorage(payload.policeReport, payload.inductionNumber, payload.fullName, "PoliceReport").then(url => ({key: 'police_report', url})));

        const uploadedFiles = await Promise.all(uploadTasks);

        // MAPPING FIX: Adding drivers_status, dob, and seizure_reason
        let updates = { 
            address: payload.address, 
            mobile_number: payload.mobileNumber, 
            company_name: payload.companyName, 
            license_expiration: payload.licenseExpiration, 
            card_status: payload.cardStatus,
            seizure_reason: payload.seizedBanReason, 
            drivers_status: payload.cardStatus, 
            induction_status: 'Pending' 
        };

        if (payload.dob) updates.dob = payload.dob;

        // Map the fast parallel uploads into the database update payload
        uploadedFiles.forEach(file => {
            if (file && file.url) updates[file.key] = file.url;
        });

        const { error: drvErr } = await getDb().from('drivers').update(updates).eq('induction_number', payload.inductionNumber);
        if (drvErr) throw drvErr;
        return { result: 'success' };
    } catch (err) { return { result: 'error', message: err.message }; }
}

// ==========================================
// 6. CALENDAR & BOOKING ENGINE
// ==========================================
async function getCalendarData(searchId, type) {
    const settings = await getSystemSettings();
    const { data: bookings } = await getDb().from('appointments').select('appointment_date, appointment_time');
    let counts = {};
    if (bookings) {
        bookings.forEach(b => {
            if (!counts[b.appointment_date]) counts[b.appointment_date] = { '9AM': 0, '11AM': 0, '2PM': 0 };
            counts[b.appointment_date][b.appointment_time || '9AM']++;
        });
    }

    const slotLimit = settings.capacity || 10;
    settings.blockedDates.forEach(d => {
        let dailyLimit = settings.customCapacities[d] || slotLimit;
        counts[d] = { '9AM': dailyLimit, '11AM': dailyLimit, '2PM': dailyLimit };
    });

    settings.blockedTimes.forEach(bt => {
        let parts = bt.split('|');
        if (parts.length === 2) {
            let d = parts[0]; let t = parts[1];
            if (!counts[d]) counts[d] = { '9AM': 0, '11AM': 0, '2PM': 0 };
            let dailyLimit = settings.customCapacities[d] || slotLimit;
            counts[d][t] = dailyLimit; 
        }
    });

    let minDate = new Date(); minDate.setDate(minDate.getDate() + 1);
    let maxDate = new Date(); maxDate.setFullYear(maxDate.getFullYear() + 2);
    return { allowedMin: minDate.toISOString().split('T')[0], allowedMax: maxDate.toISOString().split('T')[0], existingBookings: counts, settings: settings };
}

async function processBooking(payload) {
    try {
        const aptId = "APT-" + Math.floor(Math.random() * 100000);
        const { data: existing, error: fetchErr } = await getDb().from('appointments').select('*').eq('induction_number', payload.id).limit(1);
        if (fetchErr) throw fetchErr;
        
        if (existing && existing.length > 0) {
            let currentCount = existing[0].reschedule_count || 0;
            if (currentCount >= 2) return { result: 'error', message: 'Maximum of 2 reschedules allowed.' };
            const { error: updateErr } = await getDb().from('appointments').update({ appointment_date: payload.date, appointment_time: payload.time || '9AM', appointment_status: 'Rescheduled', reschedule_count: currentCount + 1, appointment_id: aptId }).eq('induction_number', payload.id);
            if (updateErr) throw updateErr; return { result: 'success', aptId: aptId, status: 'Rescheduled' };
        } else {
            const { error: insertErr } = await getDb().from('appointments').insert([{ induction_number: payload.id, appointment_date: payload.date, appointment_time: payload.time || '9AM', application_type: payload.type, appointment_status: 'Booked', appointment_id: aptId }]);
            if (insertErr) throw insertErr; return { result: 'success', aptId: aptId, status: 'Booked' };
        }
    } catch (err) { return { result: 'error', message: err.message }; }
}

// ==========================================
// 7. ADMIN DASHBOARD ACTIONS (WITH AUDIT)
// ==========================================
async function adminBulkVerify(idsString, department, attended, daPassed, reason, adminUid) {
    const idList = idsString.split(/[,\n]+/).map(id => id.trim()).filter(id => id.length > 0);
    if (idList.length === 0) return { result: 'error', message: 'No IDs provided' };
    
    try {
        const { data: currentAppts, error: fetchErr } = await getDb().from('appointments').select('induction_number, medic_status, hse_status').in('induction_number', idList);
        if (fetchErr) throw fetchErr;
        
        const todayStr = new Date().toISOString().split('T')[0];

        for (let appt of currentAppts) {
            let newMedic = appt.medic_status || 'Pending';
            let newHse = appt.hse_status || 'Pending';
            let newMaster = 'Booked';
            let hseDateUpdate = null;
            let driverExpUpdate = null;

            if (department === "Medic") { newMedic = daPassed ? 'Passed' : `Failed: ${reason}`; } 
            else if (department === "HSE") { if (attended) { newHse = 'Attended'; hseDateUpdate = todayStr; } } 
            else if (department === "Master" || department === "Admin") { newMedic = 'Passed'; newHse = 'Attended'; hseDateUpdate = todayStr; } 
            else { throw new Error('Invalid Department Permissions: ' + department); }

            if (newMedic.startsWith('Failed')) { newMaster = 'Failed D/A'; } 
            else if (newMedic === 'Passed' && newHse === 'Attended') { newMaster = 'Verified'; } 
            else { newMaster = 'Booked'; }

            let updatePayload = { medic_status: newMedic, hse_status: newHse, appointment_status: newMaster };
            if (hseDateUpdate) updatePayload.hse_date = hseDateUpdate;

            const { error: updateErr } = await getDb().from('appointments').update(updatePayload).eq('induction_number', appt.induction_number);
            if (updateErr) throw updateErr;

            // 👉 Instantly update expiration date in the main drivers table when HSE is marked attended
            if (driverExpUpdate) {
                const expStr = driverExpUpdate.toISOString().split('T')[0];
                await getDb().from('drivers').update({ induction_expiration: expStr }).eq('induction_number', appt.induction_number);
            }

            await logAuditAction(adminUid, 'STATUS_UPDATE', appt.induction_number, `Set to ${newMaster}. M:${newMedic} | H:${newHse}`);
        }
        return { result: 'success', message: `Successfully updated ${idList.length} records.` };
    } catch (err) { return { result: 'error', message: err.message }; }
}

async function markCardsGenerated(idsList, adminUid) {
    try {
        const todayStr = new Date().toISOString().split('T')[0];
        
        // Fetch current dates from both tables
        const { data: drvs } = await getDb().from('drivers').select('induction_number, date_of_issue').in('induction_number', idsList);
        const { data: appts } = await getDb().from('appointments').select('induction_number, hse_date').in('induction_number', idsList);

        for (let id of idsList) {
            const drv = (drvs || []).find(d => d.induction_number === id);
            const appt = (appts || []).find(a => a.induction_number === id);

            // 1. DATE OF ISSUE: Set ONLY if it doesn't already exist (meaning it is their first card)
            let issueDate = (drv && drv.date_of_issue) ? drv.date_of_issue : todayStr;

            // 2. EXPIRATION DATE: Enforce exactly 1 year from the HSE attended date
            let expDate = new Date();
            expDate.setFullYear(expDate.getFullYear() + 1); // Fallback failsafe
            if (appt && appt.hse_date) {
                const baseHse = new Date(appt.hse_date);
                baseHse.setFullYear(baseHse.getFullYear() + 1);
                expDate = baseHse;
            }
            const expStr = expDate.toISOString().split('T')[0];

            // Safely write both metrics to the main database
            await getDb().from('drivers').update({ 
                induction_expiration: expStr, 
                date_of_issue: issueDate,
                induction_status: 'Card Generated' 
            }).eq('induction_number', id);
            
            await getDb().from('appointments').update({ 
                appointment_status: 'Card Generated' 
            }).eq('induction_number', id);
        }
        
        await logAuditAction(adminUid, 'CARDS_GENERATED', idsList.length + ' Cards', `Generated passes for: ${idsList.join(', ')}`);
        return { result: 'success', count: idsList.length };
    } catch (err) { return { result: 'error', message: err.message }; }
}

async function getFilteredList(date, status) {
    try {
        let query = getDb().from('appointments').select('induction_number, appointment_status, application_type, medic_status, hse_status').eq('appointment_date', date);
        if (status !== 'ALL') query = query.eq('appointment_status', status);
        
        const { data: appts, error } = await query;
        if (error) throw error;
        if (!appts || appts.length === 0) return [];
        
        const ids = appts.map(a => a.induction_number);
        const { data: drvs } = await getDb().from('drivers').select('induction_number, full_name, company_name').in('induction_number', ids);
        
        return appts.map(a => {
            const d = (drvs || []).find(x => x.induction_number === a.induction_number) || {};
            return { id: a.induction_number, name: d.full_name || 'Unknown', company: d.company_name || 'Unknown', type: a.application_type === 'new' ? 'New' : 'Renewal', rawStatus: a.appointment_status, rawMedic: a.medic_status, rawHse: a.hse_status };
        });
    } catch (err) { return []; }
}

async function getAnalytics(startDate, endDate) {
    try {
        const { data, error } = await getDb().from('appointments').select('appointment_status, application_type, medic_status').gte('appointment_date', startDate).lte('appointment_date', endDate);
        if (error) throw error;
        
        let stats = { total: 0, booked: 0, verified: 0, generated: 0, newCount: 0, renewalCount: 0, failedCount: 0 };
        data.forEach(row => {
            stats.total++;
            if (row.application_type === 'new') stats.newCount++;
            if (row.application_type === 'renewal') stats.renewalCount++;
            const stat = row.appointment_status;
            if (stat === 'Booked' || stat === 'Rescheduled') stats.booked++;
            if (stat === 'Verified') stats.verified++;
            if (stat === 'Card Generated') stats.generated++;
            if (stat === 'Failed D/A' || (row.medic_status && row.medic_status.startsWith('Failed'))) stats.failedCount++;
        });
        
        return { result: 'success', data: stats };
    } catch (err) { return { result: 'error', message: err.message }; }
}

// 👉 NEW: Roster Export Fetcher
async function fetchDailyRoster(date) {
    try {
        const { data: appts, error: aErr } = await getDb().from('appointments')
            .select('induction_number, appointment_time, appointment_id')
            .eq('appointment_date', date)
            .in('appointment_status', ['Booked', 'Rescheduled', 'Verified']); 

        if (aErr) throw aErr;
        if (!appts || appts.length === 0) return { result: 'success', data: [] };

        const ids = appts.map(a => a.induction_number);
        const { data: drvs, error: dErr } = await getDb().from('drivers')
            .select('induction_number, full_name')
            .in('induction_number', ids);
        
        if (dErr) throw dErr;

        const roster = appts.map(a => {
            const d = drvs.find(x => x.induction_number === a.induction_number) || {};
            return {
                name: d.full_name || 'Unknown',
                id: a.induction_number,
                time: a.appointment_time || '9AM',
                aptId: a.appointment_id || 'N/A'
            };
        });

        // Organize cleanly by timeslot
        const timeOrder = { '9AM': 1, '11AM': 2, '2PM': 3 };
        roster.sort((a, b) => (timeOrder[a.time] || 99) - (timeOrder[b.time] || 99));

        return { result: 'success', data: roster };
    } catch (err) {
        return { result: 'error', message: err.message };
    }
}

// ==========================================
// 8. SYSTEM CONFIGURATION & POKA-YOKE ENGINE
// ==========================================
async function checkAffectedDrivers(action, date, time) {
    try {
        let query = getDb().from('appointments').select('induction_number, appointment_status, appointment_time').eq('appointment_date', date);
        if (action === 'block_time') query = query.eq('appointment_time', time);
        
        const { data: appts, error: apptErr } = await query;
        if (apptErr) throw apptErr;

        const activeAppts = (appts || []).filter(a => {
            const stat = a.appointment_status || '';
            return stat.includes('Booked') || stat.includes('Rescheduled') || stat.includes('Pending');
        });

        if (activeAppts.length === 0) return { result: 'success', data: [] };

        const ids = activeAppts.map(a => a.induction_number);
        const { data: drvs, error: drvErr } = await getDb().from('drivers').select('induction_number, full_name, mobile_number').in('induction_number', ids);
        if (drvErr) throw drvErr;

        const merged = activeAppts.map(a => {
            const d = (drvs || []).find(x => x.induction_number === a.induction_number) || {};
            return { id: a.induction_number, name: d.full_name || 'Unknown', phone: d.mobile_number || 'No Phone', time: a.appointment_time };
        });

        return { result: 'success', data: merged };
    } catch (err) { return { result: 'error', message: err.message }; }
}

async function executeBlockAndReschedule(action, blockDate, blockTime, newDate, driversToMove, forceOverride, adminUid) {
    try {
        const settings = await getSystemSettings();
        if (settings.blockedDates.includes(newDate)) return { result: 'error', message: 'Target date is completely blocked.' };

        const slotLimit = settings.customCapacities[newDate] || settings.capacity || 10;
        const maxDaily = slotLimit * 3;

        const { data: existAppts } = await getDb().from('appointments').select('appointment_time').eq('appointment_date', newDate);
        const currentBooked = existAppts ? existAppts.length : 0;

        if (!forceOverride && (currentBooked + driversToMove.length > maxDaily)) {
            return { result: 'overload', currentBooked, maxDaily, incoming: driversToMove.length };
        }

        let counts = { '9AM': 0, '11AM': 0, '2PM': 0 };
        if (existAppts) existAppts.forEach(a => { let t = a.appointment_time || '9AM'; counts[t] = (counts[t] || 0) + 1; });
        if (settings.blockedTimes.includes(`${newDate}|9AM`)) counts['9AM'] = 9999;
        if (settings.blockedTimes.includes(`${newDate}|11AM`)) counts['11AM'] = 9999;
        if (settings.blockedTimes.includes(`${newDate}|2PM`)) counts['2PM'] = 9999;

        let movedRecords = [];
        for (let t of driversToMove) {
            let assignedTime = '2PM';
            if (counts['9AM'] < slotLimit) { assignedTime = '9AM'; counts['9AM']++; }
            else if (counts['11AM'] < slotLimit) { assignedTime = '11AM'; counts['11AM']++; }
            else { assignedTime = '2PM'; counts['2PM']++; }

            await getDb().from('appointments').update({ appointment_date: newDate, appointment_time: assignedTime, appointment_status: 'Rescheduled' }).eq('induction_number', t.id);
            movedRecords.push({ originalDate: blockDate, newDate: newDate, newTime: assignedTime, id: t.id, name: t.name, phone: t.phone });
        }

        if (action === 'block_date' && !settings.blockedDates.includes(blockDate)) {
            settings.blockedDates.push(blockDate); await safeUpsertSetting('blocked_dates', settings.blockedDates.join(','));
        } else if (action === 'block_time' && !settings.blockedTimes.includes(`${blockDate}|${blockTime}`)) {
            settings.blockedTimes.push(`${blockDate}|${blockTime}`); await safeUpsertSetting('blocked_times', settings.blockedTimes.join(','));
        }

        const { data: logData } = await getDb().from('system_settings').select('setting_value').eq('setting_key', 'reschedule_list');
        let movedList = [];
        if (logData && logData.length > 0 && logData[0].setting_value) movedList = JSON.parse(logData[0].setting_value);
        
        movedList = [...movedRecords, ...movedList].slice(0, 200);
        await safeUpsertSetting('reschedule_list', JSON.stringify(movedList));

        await logAuditAction(adminUid, 'MASS_RESCHEDULE', `${driversToMove.length} Drivers`, `Moved from ${blockDate} to ${newDate}`);
        return { result: 'success' };
    } catch (err) { return { result: 'error', message: err.message }; }
}

async function applyBlockOnly(action, blockDate, blockTime, adminUid) {
    try {
        const settings = await getSystemSettings();
        if (action === 'block_date' && !settings.blockedDates.includes(blockDate)) {
            settings.blockedDates.push(blockDate); await safeUpsertSetting('blocked_dates', settings.blockedDates.join(','));
        } else if (action === 'block_time' && !settings.blockedTimes.includes(`${blockDate}|${blockTime}`)) {
            settings.blockedTimes.push(`${blockDate}|${blockTime}`); await safeUpsertSetting('blocked_times', settings.blockedTimes.join(','));
        }
        await logAuditAction(adminUid, 'CALENDAR_BLOCKED', blockDate, `Action: ${action} | Time: ${blockTime}`);
        return { result: 'success' };
    } catch (err) { return { result: 'error', message: err.message }; }
}

// ==========================================
// 9. ADMIN IMS AUTHENTICATION & AUDIT TRAIL
// ==========================================
async function adminLogin(uid, password) {
    try {
        // Fetch Admin safely ignoring case
        const { data, error } = await getDb().from('wact_admins')
            .select('*').ilike('admin_uid', uid).eq('password_hash', password).eq('is_active', true);
        
        if (error) throw error;
        if (!data || data.length === 0) return { result: 'error', message: 'Invalid Admin UID or Password, or account is disabled.' };
        
        await logAuditAction(data[0].admin_uid, 'SYSTEM_LOGIN', 'Portal Access', 'Admin successfully authenticated.');
        return { result: 'success', data: data[0] };
    } catch (err) {
        return { result: 'error', message: err.message };
    }
}

async function logAuditAction(uid, actionType, targetId, details) {
    if (!uid) return; 
    try {
        await getDb().from('audit_logs').insert([{
            admin_uid: uid,
            action_type: actionType,
            target_id: targetId,
            action_details: details
        }]);
    } catch (e) { console.error("Audit logger offline", e); }
}

// ==========================================
// QUICK ATOMIC UPDATES (For DOB and Vault)
// ==========================================
async function quickUpdate(id, name, field, value, isFile) {
    try {
        let finalValue = value;
        // If they uploaded a new file directly to the vault, handle it securely
        if (isFile && value) {
            finalValue = await uploadToStorage(value, id, name, "VaultDoc");
            if (!finalValue) throw new Error("File upload failed.");
        }
        
        // Push the update to the database
        const updates = {};
        updates[field] = finalValue;
        
        const { error } = await getDb().from('drivers').update(updates).eq('induction_number', id);
        if (error) throw error;
        
        return { result: 'success' };
    } catch (err) {
        return { result: 'error', message: err.message };
    }
}