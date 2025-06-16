import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, addDoc, onSnapshot, deleteDoc, doc, query } from 'firebase/firestore';

// Define Firebase configuration and app ID.
// These variables are provided by the Canvas environment.
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// Main App component
const App = () => {
  // State variables for Firebase and user
  const [db, setDb] = useState(null);
  const [auth, setAuth] = useState(null);
  const [userId, setUserId] = useState(null);
  const [isAuthReady, setIsAuthReady] = useState(false);

  // State variables for accounting entries
  const [entries, setEntries] = useState([]);
  const [type, setType] = useState('ingreso'); // 'ingreso', 'gasto', or 'apoyo'

  // Dynamic fields based on selected type
  const [specificDescription, setSpecificDescription] = useState(''); // Concepto / Descripción
  const [specificEntityName, setSpecificEntityName] = useState(''); // Empresa / Negocio / Nombre (Compañero)
  const [amount, setAmount] = useState('');
  const [entryDate, setEntryDate] = useState(new Date().toISOString().split('T')[0]); // Default to today's date
  const [paymentMethod, setPaymentMethod] = useState('Efectivo'); // 'Efectivo', 'Transferencia', 'Tarjeta'

  const [balance, setBalance] = useState(0);
  const [message, setMessage] = useState(''); // For user messages

  // Ref for the hidden file input (for 'Adjuntar Recibo' button)
  const fileInputRef = useRef(null);

  // Initialize Firebase and set up authentication listener
  useEffect(() => {
    try {
      const app = initializeApp(firebaseConfig);
      const firestore = getFirestore(app);
      const firebaseAuth = getAuth(app);

      setDb(firestore);
      setAuth(firebaseAuth);

      // Listen for authentication state changes
      const unsubscribe = onAuthStateChanged(firebaseAuth, async (user) => {
        if (user) {
          setUserId(user.uid);
        } else {
          // Sign in anonymously if no user is found and no initial token is provided
          // or if the initial token sign-in fails
          if (initialAuthToken) {
            try {
              await signInWithCustomToken(firebaseAuth, initialAuthToken);
            } catch (error) {
              console.error("Error signing in with custom token, signing in anonymously:", error);
              await signInAnonymously(firebaseAuth);
            }
          } else {
            await signInAnonymously(firebaseAuth);
          }
        }
        setIsAuthReady(true); // Authentication state is ready
      });

      return () => unsubscribe(); // Cleanup auth listener on unmount
    } catch (error) {
      console.error("Error initializing Firebase:", error);
      setMessage("Error al inicializar la aplicación. Intenta de nuevo.");
    }
  }, []); // Run once on component mount

  // Fetch accounting entries and calculate balance when auth is ready
  useEffect(() => {
    if (db && userId && isAuthReady) {
      const entriesCollectionRef = collection(db, `artifacts/${appId}/users/${userId}/accounting_entries`);
      // No orderBy here to avoid index requirements, sorting will be done client-side
      const q = query(entriesCollectionRef);

      const unsubscribe = onSnapshot(q, (snapshot) => {
        const newEntries = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data()
        }));
        setEntries(newEntries);
        calculateBalance(newEntries);
      }, (error) => {
        console.error("Error fetching entries:", error);
        setMessage("Error al cargar los registros contables.");
      });

      return () => unsubscribe(); // Cleanup snapshot listener
    }
  }, [db, userId, isAuthReady, appId]); // Re-run when db, userId, or isAuthReady changes

  // Clear fields and set defaults when type changes
  useEffect(() => {
    setSpecificDescription(type === 'apoyo' ? 'Apoyo' : ''); // Pre-fill 'Apoyo' if type is 'apoyo'
    setSpecificEntityName('');
    setAmount('');
    setEntryDate(new Date().toISOString().split('T')[0]);
    setPaymentMethod('Efectivo'); // Default payment method for new type
  }, [type]);

  // Calculate the current balance
  const calculateBalance = (currentEntries) => {
    const total = currentEntries.reduce((acc, entry) => {
      const amountValue = parseFloat(entry.amount);
      if (entry.type === 'ingreso' || entry.type === 'apoyo') { // 'Apoyo' also increases balance
        return acc + amountValue;
      } else {
        return acc - amountValue;
      }
    }, 0);
    setBalance(total);
  };

  // Add a new accounting entry
  const addEntry = async () => {
    if (!specificDescription || !amount || parseFloat(amount) <= 0 || !entryDate || !specificEntityName) {
      setMessage("Por favor, completa todos los campos requeridos y asegúrate de que el monto sea válido.");
      return;
    }
    // No specific companionName check here as specificEntityName covers it for 'Apoyo'

    if (!db || !userId) {
      setMessage("La aplicación no está lista. Por favor, espera.");
      return;
    }

    try {
      const newEntryData = {
        description: specificDescription,
        amount: parseFloat(amount),
        type: type,
        entityName: specificEntityName, // Unified field for company/business/companion name
        entryDate: entryDate, // Store date as YYYY-MM-DD string
        paymentMethod: paymentMethod,
        timestamp: Date.now() // Add a timestamp for client-side sorting
      };

      await addDoc(collection(db, `artifacts/${appId}/users/${userId}/accounting_entries`), newEntryData);
      setMessage('Registro añadido exitosamente.');
      // Clear fields after adding
      setSpecificDescription(type === 'apoyo' ? 'Apoyo' : ''); // Reset to default for the current type
      setSpecificEntityName('');
      setAmount('');
      setEntryDate(new Date().toISOString().split('T')[0]); // Reset to today
      setPaymentMethod('Efectivo'); // Reset to default
    } catch (e) {
      console.error("Error adding document: ", e);
      setMessage("Error al añadir el registro. Intenta de nuevo.");
    }
  };

  // Delete an accounting entry
  const deleteEntry = async (id) => {
    if (!db || !userId) {
      setMessage("La aplicación no está lista. Por favor, espera.");
      return;
    }
    try {
      await deleteDoc(doc(db, `artifacts/${appId}/users/${userId}/accounting_entries`, id));
      setMessage('Registro eliminado exitosamente.');
    } catch (e) {
      console.error("Error removing document: ", e);
      setMessage("Error al eliminar el registro. Intenta de nuevo.");
    }
  };

  // Generate and download a simple HTML receipt for 'Apoyo' entry
  const generateReceipt = (entry) => {
    const formattedDate = new Date(entry.entryDate).toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' });
    const receiptContent = `
      <!DOCTYPE html>
      <html lang="es">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Recibo de Apoyo - ${entry.description}</title>
          <style>
              body { font-family: 'Inter', sans-serif; line-height: 1.6; color: #333; margin: 20px; }
              .container { max-width: 600px; margin: 0 auto; padding: 30px; border: 1px solid #eee; box-shadow: 0 0 10px rgba(0,0,0,0.05); }
              h1 { text-align: center; color: #4F46E5; margin-bottom: 30px; }
              .details p { margin: 5px 0; }
              .amount { font-size: 2em; font-weight: bold; text-align: center; color: #10B981; margin-top: 30px; }
              .footer { text-align: center; margin-top: 50px; font-size: 0.9em; color: #777; }
          </style>
      </head>
      <body>
          <div class="container">
              <h1>Recibo de Apoyo</h1>
              <div class="details">
                  <p><strong>Fecha:</strong> ${formattedDate}</p>
                  <p><strong>Concepto:</strong> ${entry.description}</p>
                  <p><strong>Nombre:</strong> ${entry.entityName}</p>
                  <p><strong>Tipo de Apoyo:</strong> ${entry.paymentMethod}</p>
              </div>
              <div class="amount">
                  Monto: $${entry.amount.toFixed(2)} MXN
              </div>
              <div class="footer">
                  <p>Recibo generado automáticamente por la aplicación.</p>
              </div>
          </div>
      </body>
      </html>
    `;

    const blob = new Blob([receiptContent], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `recibo_apoyo_${entry.description.replace(/\s/g, '_')}_${entry.entryDate}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setMessage('Recibo de apoyo generado y descargado.');
  };

  // Handle file selection for receipts (for 'Gasto')
  const handleFileChange = (event) => {
    const file = event.target.files[0];
    if (file) {
      setMessage(`Recibo seleccionado: ${file.name}. (Nota: La subida a Google Drive requiere un backend)`);
      console.log("File selected:", file);
    } else {
      setMessage("No se seleccionó ningún archivo.");
    }
  };

  // Trigger file input click
  const triggerFileInput = () => {
    fileInputRef.current.click();
  };

  // Export all entries to a CSV file
  const exportToCSV = () => {
    if (entries.length === 0) {
      setMessage("No hay registros para exportar.");
      return;
    }

    // CSV header with unified entityName
    const header = ['ID', 'Fecha', 'Descripción', 'Monto', 'Tipo', 'Entidad', 'Método de Pago'];
    // CSV rows
    const rows = entries.map(entry => [
      entry.id,
      new Date(entry.timestamp).toLocaleDateString(), // Using timestamp for sort, entryDate for display in UI
      `"${entry.description ? entry.description.replace(/"/g, '""') : ''}"`,
      entry.amount ? entry.amount.toFixed(2) : '0.00',
      entry.type,
      `"${entry.entityName ? entry.entityName.replace(/"/g, '""') : ''}"`, // Unified field for entity name
      entry.paymentMethod || ''
    ]);

    // Combine header and rows, join with commas for columns and newlines for rows
    let csvContent = header.join(',') + '\n' + rows.map(e => e.join(',')).join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'registros_contables.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setMessage('Registros exportados a CSV.');
  };

  // Sort entries by timestamp (most recent first)
  const sortedEntries = [...entries].sort((a, b) => b.timestamp - a.timestamp);

  // Render the application UI
  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-500 to-purple-600 p-4 font-inter text-gray-100 flex items-center justify-center">
      <div className="bg-white p-6 rounded-xl shadow-2xl w-full max-w-md mx-auto transform transition-all duration-300 hover:scale-105">
        <h1 className="text-3xl font-bold text-gray-800 mb-6 text-center">Registro Contable</h1>

        {/* User ID display */}
        {userId && (
          <div className="text-sm text-gray-600 mb-4 text-center">
            <p>Tu ID de usuario: <span className="font-semibold break-all">{userId}</span></p>
          </div>
        )}

        {/* Balance display */}
        <div className="bg-gradient-to-r from-blue-500 to-teal-500 text-white p-4 rounded-lg shadow-md mb-6 text-center">
          <h2 className="text-lg font-semibold">Balance Actual:</h2>
          <p className="text-4xl font-extrabold mt-1">
            ${balance.toFixed(2)}
          </p>
        </div>

        {/* Message display */}
        {message && (
          <div className="bg-blue-100 text-blue-800 p-3 rounded-md mb-4 text-sm text-center">
            {message}
          </div>
        )}

        {/* Add New Entry Form */}
        <div className="mb-8">
          <h3 className="text-xl font-semibold text-gray-700 mb-4">Añadir Nuevo Registro</h3>

          {/* Type Selection (Ingreso, Gasto, Apoyo) - Moved to top */}
          <div className="flex justify-around mb-4">
            <label className="inline-flex items-center text-gray-700">
              <input
                type="radio"
                name="type"
                value="ingreso"
                checked={type === 'ingreso'}
                onChange={(e) => setType(e.target.value)}
                className="form-radio h-5 w-5 text-green-600"
              />
              <span className="ml-2 font-medium">Ingreso</span>
            </label>
            <label className="inline-flex items-center text-gray-700">
              <input
                type="radio"
                name="type"
                value="gasto"
                checked={type === 'gasto'}
                onChange={(e) => setType(e.target.value)}
                className="form-radio h-5 w-5 text-red-600"
              />
              <span className="ml-2 font-medium">Gasto</span>
            </label>
            <label className="inline-flex items-center text-gray-700">
              <input
                type="radio"
                name="type"
                value="apoyo"
                checked={type === 'apoyo'}
                onChange={(e) => setType(e.target.value)}
                className="form-radio h-5 w-5 text-blue-600"
              />
              <span className="ml-2 font-medium">Apoyo</span>
            </label>
          </div>

          {/* Dynamic Input Fields based on Type */}
          {type === 'ingreso' && (
            <>
              <label htmlFor="entityNameIngreso" className="block text-gray-700 text-sm font-medium mb-1">Empresa</label>
              <input
                type="text"
                id="entityNameIngreso"
                placeholder="Nombre del patrón"
                value={specificEntityName}
                onChange={(e) => setSpecificEntityName(e.target.value)}
                className="w-full p-3 mb-3 border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-400 outline-none text-gray-800"
              />

              <label htmlFor="descriptionIngreso" className="block text-gray-700 text-sm font-medium mb-1">Concepto</label>
              <input
                type="text"
                id="descriptionIngreso"
                placeholder="Descripción (ej. Cuotas, Apoyo)"
                value={specificDescription}
                onChange={(e) => setSpecificDescription(e.target.value)}
                className="w-full p-3 mb-3 border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-400 outline-none text-gray-800"
              />

              <label htmlFor="amountIngreso" className="block text-gray-700 text-sm font-medium mb-1">Monto</label>
              <input
                type="number"
                id="amountIngreso"
                placeholder="00.00 MXN"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full p-3 mb-3 border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-400 outline-none text-gray-800"
              />

              <label className="block text-gray-700 text-sm font-medium mb-1">Elige tipo de ingreso:</label>
              <div className="flex justify-around mb-4">
                <label className="inline-flex items-center text-gray-700">
                  <input
                    type="radio"
                    name="paymentMethodIngreso"
                    value="Efectivo"
                    checked={paymentMethod === 'Efectivo'}
                    onChange={(e) => setPaymentMethod(e.target.value)}
                    className="form-radio h-5 w-5 text-gray-600"
                  />
                  <span className="ml-2 font-medium">Efectivo</span>
                </label>
                <label className="inline-flex items-center text-gray-700">
                  <input
                    type="radio"
                    name="paymentMethodIngreso"
                    value="Transferencia"
                    checked={paymentMethod === 'Transferencia'}
                    onChange={(e) => setPaymentMethod(e.target.value)}
                    className="form-radio h-5 w-5 text-gray-600"
                  />
                  <span className="ml-2 font-medium">Transferencia</span>
                </label>
              </div>

              <label htmlFor="entryDateIngreso" className="block text-gray-700 text-sm font-medium mb-1">Fecha:</label>
              <input
                type="date"
                id="entryDateIngreso"
                value={entryDate}
                onChange={(e) => setEntryDate(e.target.value)}
                className="w-full p-3 mb-3 border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-400 outline-none text-gray-800"
              />
            </>
          )}

          {type === 'gasto' && (
            <>
              <label htmlFor="entityNameGasto" className="block text-gray-700 text-sm font-medium mb-1">Negocio o establecimiento</label>
              <input
                type="text"
                id="entityNameGasto"
                placeholder="ej. Office Depot"
                value={specificEntityName}
                onChange={(e) => setSpecificEntityName(e.target.value)}
                className="w-full p-3 mb-3 border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-400 outline-none text-gray-800"
              />

              <label htmlFor="descriptionGasto" className="block text-gray-700 text-sm font-medium mb-1">Descripción</label>
              <input
                type="text"
                id="descriptionGasto"
                placeholder="ej. Papel, plumas, toner"
                value={specificDescription}
                onChange={(e) => setSpecificDescription(e.target.value)}
                className="w-full p-3 mb-3 border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-400 outline-none text-gray-800"
              />

              <label htmlFor="amountGasto" className="block text-gray-700 text-sm font-medium mb-1">Monto</label>
              <input
                type="number"
                id="amountGasto"
                placeholder="00.00 MXN"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full p-3 mb-3 border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-400 outline-none text-gray-800"
              />

              <label className="block text-gray-700 text-sm font-medium mb-1">Tipo:</label>
              <div className="flex justify-around mb-4">
                <label className="inline-flex items-center text-gray-700">
                  <input
                    type="radio"
                    name="paymentMethodGasto"
                    value="Efectivo"
                    checked={paymentMethod === 'Efectivo'}
                    onChange={(e) => setPaymentMethod(e.target.value)}
                    className="form-radio h-5 w-5 text-gray-600"
                  />
                  <span className="ml-2 font-medium">Efectivo</span>
                </label>
                <label className="inline-flex items-center text-gray-700">
                  <input
                    type="radio"
                    name="paymentMethodGasto"
                    value="Tarjeta"
                    checked={paymentMethod === 'Tarjeta'}
                    onChange={(e) => setPaymentMethod(e.target.value)}
                    className="form-radio h-5 w-5 text-gray-600"
                  />
                  <span className="ml-2 font-medium">Tarjeta</span>
                </label>
              </div>

              <label htmlFor="entryDateGasto" className="block text-gray-700 text-sm font-medium mb-1">Fecha:</label>
              <input
                type="date"
                id="entryDateGasto"
                value={entryDate}
                onChange={(e) => setEntryDate(e.target.value)}
                className="w-full p-3 mb-3 border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-400 outline-none text-gray-800"
              />

              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileChange}
                className="hidden"
                accept=".jpg, .jpeg, .png, .gif, .pdf"
              />
              <button
                onClick={triggerFileInput}
                className="w-full bg-orange-500 text-white py-2 rounded-md hover:bg-orange-600 transition-colors duration-200 shadow-lg mt-4"
              >
                Adjuntar Recibo
              </button>
            </>
          )}

          {type === 'apoyo' && (
            <>
              <label htmlFor="entityNameApoyo" className="block text-gray-700 text-sm font-medium mb-1">Nombre</label>
              <input
                type="text"
                id="entityNameApoyo"
                placeholder="Juan Pérez"
                value={specificEntityName} // Use specificEntityName for companion's name
                onChange={(e) => setSpecificEntityName(e.target.value)}
                className="w-full p-3 mb-3 border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-400 outline-none text-gray-800"
              />

              <label htmlFor="descriptionApoyo" className="block text-gray-700 text-sm font-medium mb-1">Concepto</label>
              <input
                type="text"
                id="descriptionApoyo"
                placeholder="Apoyo (default)"
                value={specificDescription}
                onChange={(e) => setSpecificDescription(e.target.value)}
                className="w-full p-3 mb-3 border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-400 outline-none text-gray-800"
              />

              <label htmlFor="amountApoyo" className="block text-gray-700 text-sm font-medium mb-1">Monto</label>
              <input
                type="number"
                id="amountApoyo"
                placeholder="00.00 MXN"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full p-3 mb-3 border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-400 outline-none text-gray-800"
              />

              <label className="block text-gray-700 text-sm font-medium mb-1">Tipo de apoyo:</label>
              <div className="flex justify-around mb-4">
                <label className="inline-flex items-center text-gray-700">
                  <input
                    type="radio"
                    name="paymentMethodApoyo"
                    value="Efectivo"
                    checked={paymentMethod === 'Efectivo'}
                    onChange={(e) => setPaymentMethod(e.target.value)}
                    className="form-radio h-5 w-5 text-gray-600"
                  />
                  <span className="ml-2 font-medium">Efectivo</span>
                </label>
                <label className="inline-flex items-center text-gray-700">
                  <input
                    type="radio"
                    name="paymentMethodApoyo"
                    value="Transferencia"
                    checked={paymentMethod === 'Transferencia'}
                    onChange={(e) => setPaymentMethod(e.target.value)}
                    className="form-radio h-5 w-5 text-gray-600"
                  />
                  <span className="ml-2 font-medium">Transferencia</span>
                </label>
              </div>

              <label htmlFor="entryDateApoyo" className="block text-gray-700 text-sm font-medium mb-1">Fecha:</label>
              <input
                type="date"
                id="entryDateApoyo"
                value={entryDate}
                onChange={(e) => setEntryDate(e.target.value)}
                className="w-full p-3 mb-3 border border-gray-300 rounded-md focus:ring-2 focus:ring-indigo-400 outline-none text-gray-800"
              />

              <button
                  onClick={() => generateReceipt({ description: specificDescription, amount: parseFloat(amount), type, entityName: specificEntityName, entryDate, paymentMethod, timestamp: Date.now() })}
                  className="w-full bg-blue-500 text-white py-2 rounded-md hover:bg-blue-600 transition-colors duration-200 shadow-lg mt-4"
                >
                  Generar Recibo
                </button>
            </>
          )}

          {/* This button should be visible regardless of type selected, after dynamic fields */}
          <button
            onClick={addEntry}
            className="w-full bg-indigo-600 text-white py-3 rounded-md hover:bg-indigo-700 transition-colors duration-200 shadow-lg transform hover:scale-105 mt-4"
          >
            Añadir Registro
          </button>
        </div>

        {/* Entries List */}
        <div>
          <h3 className="text-xl font-semibold text-gray-700 mb-4">Mis Registros</h3>
          {sortedEntries.length === 0 ? (
            <p className="text-gray-500 text-center">No hay registros todavía. ¡Añade uno!</p>
          ) : (
            <ul className="space-y-3">
              {sortedEntries.map((entry) => (
                <li
                  key={entry.id}
                  className={`flex items-center justify-between p-4 rounded-lg shadow-md ${
                    entry.type === 'ingreso' ? 'bg-green-50' : entry.type === 'gasto' ? 'bg-red-50' : 'bg-blue-50'
                  }`}
                >
                  <div className="flex-grow">
                    <p className="text-gray-800 font-semibold">{entry.description}</p>
                    <p className={`text-lg font-bold ${
                      entry.type === 'ingreso' || entry.type === 'apoyo' ? 'text-green-600' : 'text-red-600'
                    }`}>
                      {entry.type === 'ingreso' || entry.type === 'apoyo' ? '+' : '-'} ${entry.amount.toFixed(2)}
                    </p>
                    <p className="text-sm text-gray-500">
                      {entry.type === 'ingreso' && `Empresa/Patrón: ${entry.entityName}`}
                      {entry.type === 'gasto' && `Negocio: ${entry.entityName}`}
                      {entry.type === 'apoyo' && `Compañero(a): ${entry.entityName}`}
                      {' | Fecha: '}{new Date(entry.entryDate).toLocaleDateString()}
                    </p>
                    <p className="text-sm text-gray-500">
                      Método: {entry.paymentMethod}
                    </p>
                  </div>
                  <button
                    onClick={() => deleteEntry(entry.id)}
                    className="ml-4 p-2 bg-red-500 text-white rounded-full hover:bg-red-600 transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-red-400"
                    aria-label="Eliminar registro"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm6 0a1 1 0 01-2 0v6a1 1 0 112 0V8z" clipRule="evenodd" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          )}
           <button
            onClick={exportToCSV}
            className="mt-6 w-full bg-purple-600 text-white py-3 rounded-md hover:bg-purple-700 transition-colors duration-200 shadow-lg transform hover:scale-105"
          >
            Exportar a CSV
          </button>
        </div>
      </div>
      {/* Tailwind CSS Script - MUST be at the end of the body for proper compilation */}
      <script src="https://cdn.tailwindcss.com"></script>
    </div>
  );
};

export default App;
