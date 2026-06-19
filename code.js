// ==========================================
// 1. SUPABASE INITIALIZATION
// ==========================================
const SUPABASE_URL = 'https://vokpqpwwdpclxnqkhsry.supabase.co'; 
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZva3BxcHd3ZHBjbHhucWtoc3J5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4NDMxMTAsImV4cCI6MjA5NzQxOTExMH0.ZEPAUHGuWoKOUSPyPcMpAlydRgDQ0bf3-p6yKZvg8_8';

const supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ==========================================
// 2. SYSTEM SETTINGS MANAGER
// ==========================================
async function getSystemSettings() {
    const { data, error } = await supabase.from('system_settings').select('*');
    if (error) { console.error("Settings Error:", error); return { capacity: 10, blockedDates: [], customCapacities: {} }; }

    let settings = { capacity: 10, blockedDates: [], customCapacities: {} };
    data.forEach(row => {
        if (row.setting_key === 'global_capacity') settings.capacity = parseInt(row.setting_value) || 10;
        if (row.setting_key === 'blocked_dates' && row.setting_value) settings.blockedDates = row.setting_value.split(',').map(d => d.trim());
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
// 3. STORAGE HELPER (File Uploads)
// ==========================================
async function uploadToStorage(fileObj, prefix) {
    if (!fileObj || !fileObj.base64) return null;
    try {
        const byteCharacters = atob(fileObj.base64);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) byteNumbers[i] = byteCharacters.charCodeAt(i);
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: fileObj.type });
        
        const fileName = `${prefix}_${Date.now()}_${fileObj.name}`;
        const { data, error } = await supabase.storage.from('driver-documents').upload(fileName, blob);
        
        if (error) throw error;
        const { data: publicUrlData } = supabase.storage.from('driver-documents').getPublicUrl(data.path);
        return publicUrlData.publicUrl;
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

        // Query driver instantly
        const { data: drivers, error } = await supabase.from('drivers').select('*').or(`induction_number.ilike.%${inputId}%,license_number.ilike.%${inputId}%`);
        if (error) throw error;
        if (!drivers || drivers.length === 0) return { result: 'error', message: 'Induction Number or License not found.' };

        const driver = drivers[0]; 
        const licenseLast5 = String(driver.license_number).trim().toLowerCase().slice(-5);
        if (licenseLast5 !== inputPass) return { result: 'error', message: 'Incorrect License Password.' };

        // Query latest appointment
        const { data: appts } = await supabase.from('appointments').select('*').eq('induction_number', driver.induction_number).order('created_at', { ascending: false }).limit(1);
        const appt = (appts && appts.length > 0) ? appts[0] : null;

        const formattedProfile = {
            fullName: driver.full_name, inductionNumber: driver.induction_number, licenseNumber: driver.license_number,
            dob: driver.dob, passportPhoto: driver.passport_photo, mobileNumber: driver.mobile_number,
            companyName: driver.company_name, address: driver.address, inductionExpiration: driver.induction_expiration,
            licenseExpiration: driver.license_expiration
        };

        const managementData = {
            status: driver.induction_status || (appt ? appt.appointment_status : "Booked"),
            daReason: driver.da_reason || "",
            currentAppointment: appt ? appt.appointment_date : "",
            rescheduleCount: appt ? appt.reschedule_count : 0
        };

        return { result: 'success', profile: formattedProfile, apptData: managementData };
    } catch (err) { return { result: 'error', message: 'Database connection failed.' }; }
}

// ==========================================
// 5. NEW & RENEWAL SUBMISSIONS
// ==========================================
async function submitNew(payload) {
    try {
        // 1. Generate new Induction Number (Find highest current number)
        const currentYear = new Date().getFullYear();
        const { data: latest } = await supabase.from('drivers').select('induction_number').like('induction_number', `%${currentYear}%`).order('induction_number', { ascending: false }).limit(1);
        
        let nextNum = 1001; // Default start
        if (latest && latest.length > 0) {
            const parts = latest[0].induction_number.split('/');
            nextNum = parseInt(parts[parts.length - 1]) + 1;
        }
        const newID = `SI/EXT/${currentYear}/${nextNum.toString().padStart(4, '0')}`;

        // 2. Upload Files to Supabase Storage
        const passportUrl = await uploadToStorage(payload.passportPhoto, newID);
        const licenseUrl = await uploadToStorage(payload.driversLicense, newID);
        const recUrl = await uploadToStorage(payload.recLetter, newID);

        // 3. Insert Driver
        const { error } = await supabase.from('drivers').insert([{
            induction_number: newID, full_name: payload.fullName, address: payload.address, state: payload.state,
            lga: payload.lga, religion: payload.religion, mobile_number: payload.mobile, dob: payload.dob,
            marital_status: payload.maritalStatus, license_number: payload.licenseDetails, license_expiration: payload.licenseExpDate,
            company_name: payload.companyName, ref1_name: payload.ref1Name, ref1_address: payload.ref1Address,
            ref1_position: payload.ref1Position, ref1_duration: payload.ref1Duration, ref1_contact: payload.ref1Contact,
            ref2_name: payload.ref2Name, passport_photo: passportUrl, drivers_license: licenseUrl, recommendation_letter: recUrl,
            induction_status: 'Pending'
        }]);

        if (error) throw error;
        return { result: 'success', inductionNumber: newID };
    } catch (err) { return { result: 'error', message: err.message }; }
}

async function submitRenewal(payload) {
    try {
        // Upload new files if provided
        let updates = { 
            address: payload.address, mobile_number: payload.mobileNumber, company_name: payload.companyName, 
            license_expiration: payload.licenseExpiration, da_reason: payload.seizedBanReason, induction_status: 'Pending'
        };

        if (payload.passportPhoto) updates.passport_photo = await uploadToStorage(payload.passportPhoto, payload.inductionNumber);
        if (payload.driversLicense) updates.drivers_license = await uploadToStorage(payload.driversLicense, payload.inductionNumber);
        
        // Update Driver Table
        const { error: drvErr } = await supabase.from('drivers').update(updates).eq('induction_number', payload.inductionNumber);
        if (drvErr) throw drvErr;

        return { result: 'success' };
    } catch (err) { return { result: 'error', message: err.message }; }
}

// ==========================================
// 6. CALENDAR & BOOKING ENGINE
// ==========================================
async function getCalendarData(searchId, type) {
    const settings = await getSystemSettings();
    
    // Aggregate bookings directly from PostgreSQL
    const { data: bookings } = await supabase.from('appointments').select('appointment_date, appointment_time');
    let counts = {};
    if (bookings) {
        bookings.forEach(b => {
            if (!counts[b.appointment_date]) counts[b.appointment_date] = { '9AM': 0, '11AM': 0, '2PM': 0 };
            counts[b.appointment_date][b.appointment_time || '9AM']++;
        });
    }

    let minDate = new Date(); minDate.setDate(minDate.getDate() + 1);
    let maxDate = new Date(); maxDate.setFullYear(maxDate.getFullYear() + 2);

    return {
        allowedMin: minDate.toISOString().split('T')[0],
        allowedMax: maxDate.toISOString().split('T')[0],
        existingBookings: counts,
        settings: settings
    };
}

async function processBooking(payload) {
    try {
        const aptId = "APT-" + Math.floor(Math.random() * 100000);
        
        // Check if appointment exists
        const { data: existing } = await supabase.from('appointments').select('*').eq('induction_number', payload.id).limit(1);
        
        if (existing && existing.length > 0) {
            let currentCount = existing[0].reschedule_count || 0;
            if (currentCount >= 2) return { result: 'error', message: 'Maximum of 2 reschedules allowed.' };
            
            await supabase.from('appointments').update({
                appointment_date: payload.date, appointment_time: payload.time || '9AM', 
                appointment_status: 'Rescheduled', reschedule_count: currentCount + 1, id: aptId
            }).eq('induction_number', payload.id);
            return { result: 'success', aptId: aptId, status: 'Rescheduled' };
        } else {
            await supabase.from('appointments').insert([{
                induction_number: payload.id, appointment_date: payload.date, appointment_time: payload.time || '9AM',
                application_type: payload.type, appointment_status: 'Booked', id: aptId
            }]);
            return { result: 'success', aptId: aptId, status: 'Booked' };
        }
    } catch (err) { return { result: 'error', message: err.message }; }
}

// ==========================================
// 7. ADMIN DASHBOARD ACTIONS
// ==========================================
async function adminBulkVerify(idsString, passcode, attended, daPassed, reason) {
    const idList = idsString.split(/[,\n]+/).map(id => id.trim().toLowerCase()).filter(id => id.length > 0);
    if (idList.length === 0) return { result: 'error', message: 'No IDs provided' };

    try {
        let statusUpdate = "";
        let daUpdate = "";

        if (passcode === "MEDIC2026") {
            statusUpdate = daPassed ? "Booked" : "Failed D/A";
            daUpdate = daPassed ? "" : reason;
        } else if (passcode === "HSE2026") {
            if (attended) statusUpdate = "Verified";
        } else if (passcode === "MASTER2026" || passcode === "WACT2026") {
            statusUpdate = "Verified";
            daUpdate = "";
        } else { return { result: 'error', message: 'Invalid Passcode' }; }

        // Update Drivers Table (for DA status)
        if (passcode === "MEDIC2026" || passcode === "MASTER2026") {
            await supabase.from('drivers').update({ da_reason: daUpdate, induction_status: statusUpdate }).in('induction_number', idList);
        }

        // Update Appointments Table
        if (statusUpdate) {
            await supabase.from('appointments').update({ appointment_status: statusUpdate }).in('induction_number', idList);
        }

        return { result: 'success', message: `Successfully updated ${idList.length} records.` };
    } catch (err) { return { result: 'error', message: err.message }; }
}

async function markCardsGenerated(idsList) {
    try {
        const expirationDate = new Date();
        expirationDate.setFullYear(expirationDate.getFullYear() + 1);

        await supabase.from('appointments').update({ appointment_status: 'Card Generated' }).in('induction_number', idsList);
        await supabase.from('drivers').update({ induction_expiration: expirationDate.toISOString().split('T')[0], induction_status: 'Card Generated' }).in('induction_number', idsList);
        
        return { result: 'success', count: idsList.length };
    } catch (err) { return { result: 'error', message: err.message }; }
}

async function getFilteredList(date, status) {
    try {
        const { data, error } = await supabase.from('appointments')
            .select('induction_number, appointment_status, application_type, drivers (full_name, company_name)')
            .eq('appointment_status', status)
            .eq('appointment_date', date);
            
        if (error) throw error;
        
        return data.map(row => ({
            id: row.induction_number,
            name: row.drivers.full_name,
            company: row.drivers.company_name,
            type: row.application_type === 'new' ? 'New' : 'Renewal'
        }));
    } catch (err) { return []; }
}

async function getAnalytics(startDate, endDate) {
    try {
        const { data, error } = await supabase.from('appointments').select('appointment_status, application_type').gte('appointment_date', startDate).lte('appointment_date', endDate);
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