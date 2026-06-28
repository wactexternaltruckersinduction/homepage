// ==========================================
// 1. SUPABASE INITIALIZATION
// ==========================================
const SUPABASE_URL = 'https://vokpqpwwdpclxnqkhsry.supabase.co'; 
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZva3BxcHd3ZHBjbHhucWtoc3J5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4NDMxMTAsImV4cCI6MjA5NzQxOTExMH0.ZEPAUHGuWoKOUSPyPcMpAlydRgDQ0bf3-p6yKZvg8_8';

// Safely bind to the window object to ensure global availability
window.supabaseClient = null;
if (typeof supabase !== 'undefined') {
    window.supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

// ==========================================
// 2. SYSTEM SETTINGS MANAGER
// ==========================================
async function getSystemSettings() {
    const { data, error } = await supabaseClient.from('system_settings').select('*');
    if (error) return { capacity: 10, blockedDates: [], blockedTimes: [], customCapacities: {} };

    let settings = { capacity: 10, blockedDates: [], blockedTimes: [], customCapacities: {} };
    
    data.forEach(row => {
        if (row.setting_key === 'global_capacity') settings.capacity = parseInt(row.setting_value) || 10;
        
        if (row.setting_key === 'blocked_dates' && row.setting_value) {
            settings.blockedDates = row.setting_value.split(',').map(d => d.trim());
        }
        
        // NEW: Block specific times on specific dates (e.g., "2026-10-05|9AM")
        if (row.setting_key === 'blocked_times' && row.setting_value) {
            settings.blockedTimes = row.setting_value.split(',').map(d => d.trim());
        }
        
        // FIXED: Granular custom capacities (e.g., "2026-10-05:15" or "2026-10-06|9AM:5")
        if (row.setting_key === 'custom_capacities' && row.setting_value) {
            row.setting_value.split(',').forEach(pair => {
                let parts = pair.split(':');
                if (parts.length === 2) settings.customCapacities[parts[0].trim()] = parseInt(parts[1].trim());
            });
        }
    });
    return settings;
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
        
        const { data, error } = await supabaseClient.storage.from('driver-documents')
            .upload(fileName, blob, { upsert: true, contentType: fileObj.type });
        
        if (error) throw error;
        
        const { data: publicUrlData } = supabaseClient.storage.from('driver-documents').getPublicUrl(data.path);
        return publicUrlData.publicUrl + "?t=" + Date.now(); 
    } catch (err) {
        console.error("Upload failed:", err.message);
        return null;
    }
}

// ==========================================
// 4. DRIVER LOGIN ENGINE
// ==========================================
async function driverLogin(inductionNumber, password) {
    try {
        const inputId = String(inductionNumber).trim();
        const inputPass = String(password).trim().toLowerCase();

        const [idSearch, licSearch] = await Promise.all([
            supabaseClient.from('drivers').select('*').ilike('induction_number', `%${inputId}%`),
            supabaseClient.from('drivers').select('*').ilike('license_number', `%${inputId}%`)
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

        const { data: appts } = await supabaseClient
            .from('appointments')
            .select('*')
            .eq('induction_number', validDriver.induction_number)
            .order('created_at', { ascending: false })
            .limit(1);
            
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
                isSuspended = true;
                banEndDate.setFullYear(banEndDate.getFullYear() + 99); 
            } else if (match) {
                const amount = parseInt(match[1]);
                const unit = match[2].toLowerCase();
                if (unit === 'week') banEndDate.setDate(banEndDate.getDate() + (amount * 7));
                if (unit === 'month') banEndDate.setMonth(banEndDate.getMonth() + amount);
                if (unit === 'year') banEndDate.setFullYear(banEndDate.getFullYear() + amount);

                if (new Date() < banEndDate) {
                    isSuspended = true;
                    suspensionEnd = banEndDate.toISOString().split('T')[0];
                } else {
                    // 👉 CORRECTION 1: THE BAN HAS EXPIRED! AUTO-CLEAN THE DATABASE
                    supabaseClient.from('appointments').update({
                        medic_status: 'Pending', hse_status: 'Pending', appointment_status: 'Booked', reschedule_count: 0
                    }).eq('induction_number', validDriver.induction_number).then();
                    
                    supabaseClient.from('drivers').update({ da_reason: "" })
                    .eq('induction_number', validDriver.induction_number).then();
                    
                    activeBanReason = "";
                    appt.appointment_status = "Booked"; // Update local memory so UI sees them as clean today
                }
            }
        }

        const formattedProfile = {
            fullName: validDriver.full_name, inductionNumber: validDriver.induction_number, licenseNumber: validDriver.license_number,
            dob: validDriver.dob, passportPhoto: validDriver.passport_photo, mobileNumber: validDriver.mobile_number,
            companyName: validDriver.company_name, address: validDriver.address, inductionExpiration: validDriver.induction_expiration,
            licenseExpiration: validDriver.license_expiration, docLicense: validDriver.drivers_license,
            docOther: validDriver.other_documents || validDriver.recommendation_letter 
        };

        const managementData = {
            status: appt ? appt.appointment_status : "Booked", 
            daReason: activeBanReason, 
            currentAppointment: appt ? appt.appointment_date : "",
            appointmentTime: appt ? appt.appointment_time : "",
            appointmentId: appt ? appt.appointment_id : "",
            hseDate: appt ? appt.hse_date : "", // 👉 CORRECTION 3: Pulling the HSE Date for the portal
            rescheduleCount: appt ? appt.reschedule_count : 0,
            isSuspended: isSuspended,
            suspensionEnd: suspensionEnd
        };

        return { result: 'success', profile: formattedProfile, apptData: managementData };
    } catch (err) { return { result: 'error', message: 'Database connection failed.' }; }
}

// ==========================================
// 5. NEW & RENEWAL SUBMISSIONS
// ==========================================
async function submitNew(payload) {
    try {
        const expDate = new Date(payload.licenseExpDate);
        const minValidDate = new Date();
        minValidDate.setMonth(minValidDate.getMonth() + 3);
        if (expDate < minValidDate) return { result: 'error', message: "Application Rejected: Driver's license must be valid for at least 3 months." };

        const cleanLicense = String(payload.licenseDetails).trim();
        const { data: existingDriver, error: licErr } = await supabaseClient
            .from('drivers')
            .select('full_name, induction_number')
            .ilike('license_number', cleanLicense)
            .limit(1);

        if (licErr) throw licErr;
        
        if (existingDriver && existingDriver.length > 0) {
            const recoveredName = existingDriver[0].full_name || "Unknown";
            const recoveredId = existingDriver[0].induction_number || "Unknown";
            return { 
                result: 'error', 
                message: `Driver already exists! Please login using the Renewal Portal to access details.\n\n👤 Name: ${recoveredName}\n🆔 Induction Number: ${recoveredId}` 
            };
        }

        const currentYear = new Date().getFullYear();
        let allDrivers = [];
        let fetchMore = true;
        let rangeStart = 0;
        const step = 1000; 

        while (fetchMore) {
            const { data, error: numErr } = await supabaseClient
                .from('drivers')
                .select('induction_number')
                .range(rangeStart, rangeStart + step - 1);
                
            if (numErr) throw numErr;
            
            if (data && data.length > 0) {
                allDrivers.push(...data);
                rangeStart += step;
                if (data.length < step) fetchMore = false; 
            } else {
                fetchMore = false;
            }
        }

        let highestNum = 1000; 
        if (allDrivers.length > 0) {
            for (let d of allDrivers) {
                if (d.induction_number) {
                    const parts = d.induction_number.split('/');
                    const lastDigit = parseInt(parts[parts.length - 1]);
                    if (!isNaN(lastDigit) && lastDigit > highestNum) highestNum = lastDigit;
                }
            }
        }
        
        const nextNum = highestNum + 1;
        const newID = `SI/EXT/${currentYear}/${nextNum.toString().padStart(4, '0')}`;

        const passportUrl = await uploadToStorage(payload.passportPhoto, newID, payload.fullName, "Passport");
        const licenseUrl = await uploadToStorage(payload.driversLicense, newID, payload.fullName, "License");
        const otherUrl = await uploadToStorage(payload.otherDocuments || payload.recLetter, newID, payload.fullName, "OtherDoc");

        const { error } = await supabaseClient.from('drivers').insert([{
            induction_number: newID, full_name: payload.fullName, address: payload.address, state: payload.state,
            lga: payload.lga, religion: payload.religion, mobile_number: payload.mobile, dob: payload.dob,
            marital_status: payload.maritalStatus, license_number: cleanLicense, license_expiration: payload.licenseExpDate,
            company_name: payload.companyName, ref1_name: payload.ref1Name, ref1_address: payload.ref1Address,
            ref1_position: payload.ref1Position, ref1_duration: payload.ref1Duration, ref1_contact: payload.ref1Contact,
            ref2_name: payload.ref2Name, passport_photo: passportUrl, drivers_license: licenseUrl, other_documents: otherUrl,
            induction_status: 'Pending'
        }]);

        if (error) throw error;
        
        return { result: 'success', inductionNumber: newID };
    } catch (err) { 
        if (err.message && err.message.includes('unique constraint')) {
            return { result: 'error', message: 'System generated a duplicate ID. Please try submitting again.' };
        }
        return { result: 'error', message: err.message }; 
    }
}

async function submitRenewal(payload) {
    try {
        const expDate = new Date(payload.licenseExpiration);
        const minValidDate = new Date();
        minValidDate.setMonth(minValidDate.getMonth() + 3);
        if (expDate < minValidDate) return { result: 'error', message: "Application Rejected: Driver's license must be valid for at least 3 months." };

        let updates = { 
            address: payload.address, mobile_number: payload.mobileNumber, company_name: payload.companyName, 
            license_expiration: payload.licenseExpiration, seizure_reason: payload.seizedBanReason, induction_status: 'Pending'
        };

        if (payload.passportPhoto) updates.passport_photo = await uploadToStorage(payload.passportPhoto, payload.inductionNumber, payload.fullName, "Passport");
        if (payload.driversLicense) updates.drivers_license = await uploadToStorage(payload.driversLicense, payload.inductionNumber, payload.fullName, "License");
        if (payload.otherDocuments) updates.other_documents = await uploadToStorage(payload.otherDocuments, payload.inductionNumber, payload.fullName, "OtherDoc");
        
        const { error: drvErr } = await supabaseClient.from('drivers').update(updates).eq('induction_number', payload.inductionNumber);
        if (drvErr) throw drvErr;

        return { result: 'success' };
    } catch (err) { return { result: 'error', message: err.message }; }
}

async function quickUpdate(inductionNumber, driverName, fieldName, value, isFile = false) {
    try {
        let finalValue = value;
        if (isFile && value) {
            finalValue = await uploadToStorage(value, inductionNumber, driverName, fieldName);
            if (!finalValue) throw new Error("File upload failed to connect to storage bucket.");
        }
        
        const { error } = await supabaseClient.from('drivers').update({ [fieldName]: finalValue }).eq('induction_number', inductionNumber);
        if (error) throw error;
        
        return { result: 'success' };
    } catch (err) {
        return { result: 'error', message: err.message };
    }
}

// ==========================================
// 6. CALENDAR & BOOKING ENGINE
// ==========================================
async function getCalendarData(searchId, type) {
    const settings = await getSystemSettings();
    const { data: bookings } = await supabaseClient.from('appointments').select('appointment_date, appointment_time');
    
    let counts = {};
    if (bookings) {
        bookings.forEach(b => {
            if (!counts[b.appointment_date]) counts[b.appointment_date] = { '9AM': 0, '11AM': 0, '2PM': 0 };
            counts[b.appointment_date][b.appointment_time || '9AM']++;
        });
    }

    let minDate = new Date(); minDate.setDate(minDate.getDate() + 1);
    let maxDate = new Date(); maxDate.setFullYear(maxDate.getFullYear() + 2);

    // Pass settings perfectly to UI so the frontend can calculate exact slot availability
    return { allowedMin: minDate.toISOString().split('T')[0], allowedMax: maxDate.toISOString().split('T')[0], existingBookings: counts, settings: settings };
}

async function processBooking(payload) {
    try {
        const aptId = "APT-" + Math.floor(Math.random() * 100000);
        
        const { data: existing, error: fetchErr } = await supabaseClient.from('appointments').select('*').eq('induction_number', payload.id).limit(1);
        if (fetchErr) throw fetchErr;
        
        if (existing && existing.length > 0) {
            let currentCount = existing[0].reschedule_count || 0;
            if (currentCount >= 2) return { result: 'error', message: 'Maximum of 2 reschedules allowed. Please contact HSE at 08129915418 to clear your record.' };
            
            const { error: updateErr } = await supabaseClient.from('appointments').update({
                appointment_date: payload.date, appointment_time: payload.time || '9AM', 
                appointment_status: 'Rescheduled', reschedule_count: currentCount + 1, appointment_id: aptId
            }).eq('induction_number', payload.id);
            if (updateErr) throw updateErr;
            return { result: 'success', aptId: aptId, status: 'Rescheduled' };
        } else {
            const { error: insertErr } = await supabaseClient.from('appointments').insert([{
                induction_number: payload.id, appointment_date: payload.date, appointment_time: payload.time || '9AM',
                application_type: payload.type, appointment_status: 'Booked', appointment_id: aptId
            }]);
            if (insertErr) throw insertErr;
            return { result: 'success', aptId: aptId, status: 'Booked' };
        }
    } catch (err) { 
        console.error("Booking Error:", err.message); return { result: 'error', message: err.message }; 
    }
}

// ==========================================
// 7. ADMIN DASHBOARD ACTIONS 
// ==========================================
async function adminBulkVerify(idsString, passcode, attended, daPassed, reason) {
    const idList = idsString.split(/[,\n]+/).map(id => id.trim()).filter(id => id.length > 0);
    if (idList.length === 0) return { result: 'error', message: 'No IDs provided' };
    
    try {
        const { data: currentAppts, error: fetchErr } = await supabaseClient
            .from('appointments')
            .select('induction_number, medic_status, hse_status')
            .in('induction_number', idList);
            
        if (fetchErr) throw fetchErr;
        
        const todayStr = new Date().toISOString().split('T')[0];

        for (let appt of currentAppts) {
            let newMedic = appt.medic_status || 'Pending';
            let newHse = appt.hse_status || 'Pending';
            let newMaster = 'Booked';
            let hseDateUpdate = null;

            if (passcode === "MEDIC2026") {
                newMedic = daPassed ? 'Passed' : `Failed: ${reason}`;
            } else if (passcode === "HSE2026") {
                if (attended) { newHse = 'Attended'; hseDateUpdate = todayStr; } // 👉 CORRECTION 3: Record Date
            } else if (passcode === "MASTER2026" || passcode === "WACT2026") {
                newMedic = 'Passed'; newHse = 'Attended'; hseDateUpdate = todayStr;
            } else { throw new Error('Invalid Passcode'); }

            if (newMedic.startsWith('Failed')) { newMaster = 'Failed D/A'; } 
            else if (newMedic === 'Passed' && newHse === 'Attended') { newMaster = 'Verified'; } 
            else { newMaster = 'Booked'; }

            let updatePayload = { medic_status: newMedic, hse_status: newHse, appointment_status: newMaster };
            if (hseDateUpdate) updatePayload.hse_date = hseDateUpdate;

            await supabaseClient.from('appointments').update(updatePayload).eq('induction_number', appt.induction_number);
        }
        
        return { result: 'success', message: `Successfully updated ${idList.length} records.` };
    } catch (err) { return { result: 'error', message: err.message }; }
}

async function getAnalytics(startDate, endDate) {
    try {
        const { data, error } = await supabaseClient.from('appointments').select('appointment_status, application_type, medic_status').gte('appointment_date', startDate).lte('appointment_date', endDate);
        if (error) throw error;
        
        let stats = { total: 0, booked: 0, verified: 0, generated: 0, newCount: 0, renewalCount: 0 };
        let failureReasons = {}; // 👉 CORRECTION 4: Dynamic Failure Tally

        data.forEach(row => {
            stats.total++;
            if (row.application_type === 'new') stats.newCount++;
            if (row.application_type === 'renewal') stats.renewalCount++;
            
            const stat = row.appointment_status;
            if (stat === 'Booked' || stat === 'Rescheduled') stats.booked++;
            if (stat === 'Verified') stats.verified++;
            if (stat === 'Card Generated') stats.generated++;
            
            // Tally the exact failure reasons
            if (row.medic_status && row.medic_status.startsWith('Failed:')) {
                const cleanReason = row.medic_status.replace('Failed: ', '').split(' (')[0].trim(); // Grabs "Positive to Alcohol"
                failureReasons[cleanReason] = (failureReasons[cleanReason] || 0) + 1;
            }
        });
        
        return { result: 'success', data: stats, failures: failureReasons };
    } catch (err) { return { result: 'error', message: err.message }; }
}

async function markCardsGenerated(idsList) {
    try {
        const expirationDate = new Date(); expirationDate.setFullYear(expirationDate.getFullYear() + 1);
        await supabaseClient.from('appointments').update({ appointment_status: 'Card Generated' }).in('induction_number', idsList);
        await supabaseClient.from('drivers').update({ induction_expiration: expirationDate.toISOString().split('T')[0], induction_status: 'Card Generated' }).in('induction_number', idsList);
        return { result: 'success', count: idsList.length };
    } catch (err) { return { result: 'error', message: err.message }; }
}

async function getFilteredList(date, status) {
    try {
        const { data, error } = await supabaseClient.from('appointments').select('induction_number, appointment_status, application_type, drivers (full_name, company_name)').eq('appointment_status', status).eq('appointment_date', date);
        if (error) throw error;
        return data.map(row => ({ id: row.induction_number, name: row.drivers.full_name, company: row.drivers.company_name, type: row.application_type === 'new' ? 'New' : 'Renewal' }));
    } catch (err) { return []; }
}

async function getAnalytics(startDate, endDate) {
    try {
        const { data, error } = await supabaseClient.from('appointments').select('appointment_status, application_type').gte('appointment_date', startDate).lte('appointment_date', endDate);
        if (error) throw error;
        let stats = { total: 0, booked: 0, verified: 0, generated: 0, newCount: 0, renewalCount: 0 };
        data.forEach(row => {
            stats.total++;
            if (row.application_type === 'new') stats.newCount++;
            if (row.application_type === 'renewal') stats.renewalCount++;
            const stat = row.appointment_status.toLowerCase();
            if (stat.includes('booked') || stat.includes('rescheduled')) stats.booked++;
            if (stat.includes('verified')) stats.verified++;
            if (stat.includes('generated')) stats.generated++;
        });
        return { result: 'success', data: stats };
    } catch (err) { return { result: 'error', message: err.message }; }
}