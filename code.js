// Initialize Supabase Client
const SUPABASE_URL = 'https://your-project-id.supabase.cohttps://supabase.com/dashboard/project/vokpqpwwdpclxnqkhsry/settings/api-keys'; // Replace with your actual URL
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZva3BxcHd3ZHBjbHhucWtoc3J5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4NDMxMTAsImV4cCI6MjA5NzQxOTExMH0.ZEPAUHGuWoKOUSPyPcMpAlydRgDQ0bf3-p6yKZvg8_8'; // Replace with your actual Key

const supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// NEW SUPABASE WAY (Instant & Lightweight)
async function findDriverRecord(searchId) {
    try {
        // 1. Ask Supabase for the exact row where induction_number matches
        const { data, error } = await supabase
            .from('drivers')
            .select('*')
            .eq('induction_number', searchId)
            .single();

        if (error) throw error;
        
        // 2. Data found! 
        console.log("Driver Found:", data.full_name);
        return data;

    } catch (err) {
        console.error("Database query failed:", err.message);
        return null;
    }
}
async function driverLogin(inductionNumber, password) {
    try {
        const inputId = String(inductionNumber).trim();
        const inputPass = String(password).trim().toLowerCase();

        // 1. Find the Driver instantly
        const { data: drivers, error: driverError } = await supabase
            .from('drivers')
            .select('*')
            .or(`induction_number.ilike.%${inputId}%,license_number.ilike.%${inputId}%`);

        if (driverError) throw driverError;
        if (!drivers || drivers.length === 0) return { result: 'error', message: 'Induction Number or License not found.' };

        // 2. Verify Password (last 5 digits of license)
        const driver = drivers[0]; 
        const fullLicense = String(driver.license_number).trim().toLowerCase();
        const licenseLast5 = fullLicense.slice(-5);

        if (licenseLast5 !== inputPass) return { result: 'error', message: 'Incorrect License Password.' };

        // 3. Find their active appointment
        const { data: appts } = await supabase
            .from('appointments')
            .select('*')
            .eq('induction_number', driver.induction_number)
            .order('created_at', { ascending: false })
            .limit(1);

        const appt = (appts && appts.length > 0) ? appts[0] : null;

        // 4. Package data exactly how your frontend buildDashboard() expects it!
        const formattedProfile = {
            fullName: driver.full_name,
            inductionNumber: driver.induction_number,
            licenseNumber: driver.license_number,
            dob: driver.dob,
            passportPhoto: driver.passport_photo,
            mobileNumber: driver.mobile_number,
            companyName: driver.company_name,
            address: driver.address,
            inductionExpiration: driver.induction_expiration,
            licenseExpiration: driver.license_expiration
        };

        const managementData = {
            status: driver.induction_status || "Booked",
            daReason: driver.da_reason || "",
            currentAppointment: appt ? appt.appointment_date : "",
            rescheduleCount: appt ? appt.reschedule_count : 0
        };

        return { result: 'success', profile: formattedProfile, apptData: managementData };

    } catch (err) {
        console.error("System Error:", err.message);
        return { result: 'error', message: 'Database connection failed.' };
    }
}